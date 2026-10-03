import type { Frame } from "@sweatpants/frame-renderer";
import { EventType, type Message } from "@ag-ui/core";
import type { Operation } from "effection";
import {
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import {
  appendAGUIMessage,
  createChatProjection,
  findTextParts,
  foldAGUIEvents,
  materializeChatMessages,
  publicRootProjection,
  transitionChatProjection,
  updateTextPartFrame,
  type ChatLocalPart,
  type ChatUIMessage,
  type ChatProjectionAction,
  type ChatProjectionState,
  type AGUIEvent,
  type ConversationWindowFrame,
  type PublicHistoryPage,
  type PublicProjectionRoot,
  type PublicRootProjectionNote,
  type FramePipeline,
  type FramePipelineFactory,
} from "@sweatpants/chat-core";

interface DirtyPart {
  readonly messageId: string;
  readonly partId: string;
  readonly fallbackText: string;
  readonly done: boolean;
}

interface TextPresentation {
  readonly text: string;
  readonly state: "streaming" | "done";
  readonly frame: Frame;
  readonly rendered: string;
}

export type LiveCompactorAction = Exclude<ChatProjectionAction, { readonly type: "text-changed" }>;

function rootConflict(message: string): Error {
  return Object.assign(new Error(message), { code: "public_root_conflict" });
}

type LiveProjectionNote =
  | {
      readonly kind: "roots-merged";
      readonly sealed: number;
      readonly hot: number;
      readonly merged: number;
    }
  | { readonly kind: "live-events-replayed"; readonly events: number }
  // Nested notes from the shared chat-core public-root projection.
  | PublicRootProjectionNote;

/**
 * The client's view of a conversation: merge sealed and hot roots, project them
 * with the same program the runtime uses, then replay any post-window live
 * events. Sealed roots win identity ties so an in-flight hot root can never
 * displace published history.
 */
export function* liveProjection(params: {
  readonly sealed: ReadonlyMap<string, PublicProjectionRoot>;
  readonly hot: ReadonlyMap<string, PublicProjectionRoot>;
  readonly liveEvents: readonly AGUIEvent[];
  readonly requireComplete: boolean;
}): ProjectionProgram<ChatProjectionState, LiveProjectionNote> {
  const roots = yield* stage("merge-roots", function* () {
    const merged = new Map(params.sealed);
    for (const [rootId, root] of params.hot) {
      if (!merged.has(rootId)) merged.set(rootId, root);
    }
    yield* note({
      kind: "roots-merged",
      sealed: params.sealed.size,
      hot: params.hot.size,
      merged: merged.size,
    });
    return [...merged.values()];
  });

  // Delegating to the runtime's own program keeps root identity, position, and
  // anchor-cycle rules in one place; its stages nest under this path.
  const projected = yield* stage("project-roots", () => publicRootProjection(roots));

  const replayed = yield* stage("replay-live", function* () {
    const current = foldAGUIEvents(projected, params.liveEvents);
    yield* note({ kind: "live-events-replayed", events: params.liveEvents.length });
    return current;
  });

  if (!params.requireComplete) {
    return replayed;
  }

  return yield* stage("assert-complete", function* () {
    if (replayed.pendingChildren.size > 0) {
      throw Object.assign(
        new Error(
          `Public history page is missing parents for ${[...replayed.pendingChildren.keys()].join(
            ", ",
          )}`,
        ),
        { code: "public_history_parent_missing" },
      );
    }
    return replayed;
  });
}

function runLiveProjection(params: Parameters<typeof liveProjection>[0]): ChatProjectionState {
  const outcome = runProjectionProgram(
    () => liveProjection(params),
    (error) => error,
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * Presentation-side projection and frame compactor.
 * A drained transport batch folds every event, while text deltas accumulate in
 * part-local pipelines that are each pulled at most once per published frame.
 */
export class LiveChatCompactor {
  private current: ChatProjectionState = createChatProjection();
  private readonly sealedRoots = new Map<string, PublicProjectionRoot>();
  private readonly hotRoots = new Map<string, PublicProjectionRoot>();
  private liveEvents: AGUIEvent[] = [];
  private lineageId: string | null = null;
  private readonly pipelines = new Map<string, FramePipeline>();
  private readonly dirtyParts = new Map<string, DirtyPart>();
  private pendingPresentationReconciliation: ReadonlyMap<string, TextPresentation> | null = null;
  /** Invalidates presentation work that suspended across an authoritative replacement. */
  private projectionGeneration = 0;

  constructor(private readonly pipelineFactory: FramePipelineFactory) {}

  get projection(): ChatProjectionState {
    return this.current;
  }

  get pendingParents(): readonly string[] {
    return [...this.current.pendingChildren.keys()];
  }

  get error(): Error | null {
    return this.current.error;
  }

  ingest(event: AGUIEvent): readonly LiveCompactorAction[] {
    if (event.type === EventType.MESSAGES_SNAPSHOT) {
      this.projectionGeneration += 1;
      this.sealedRoots.clear();
      this.hotRoots.clear();
      this.lineageId = null;
      this.liveEvents = [];
      this.pipelines.clear();
      this.dirtyParts.clear();
      this.pendingPresentationReconciliation = null;
    }
    this.liveEvents.push(event);
    const transition = transitionChatProjection(this.current, event);
    this.current = transition.projection;
    const actions: LiveCompactorAction[] = [];
    for (const action of transition.actions) {
      if (action.type === "text-changed") {
        this.bufferText(action.messageId, action.kind, action.delta, action.done);
      } else {
        actions.push(action);
      }
    }
    return actions;
  }

  append(message: Message): void {
    this.current = appendAGUIMessage(this.current, message);
  }

  applyWindow(window: ConversationWindowFrame): readonly LiveCompactorAction[] {
    if (this.lineageId !== window.lineageId) {
      this.sealedRoots.clear();
    }
    if (window.windowMode === "continue") {
      this.installSealedRoots(this.sealedRoots, window.sealedCatchupRoots);
    }
    this.hotRoots.clear();
    for (const root of window.hotRoots) {
      this.hotRoots.set(root.rootId, root);
    }
    this.lineageId = window.lineageId;
    // A window is an authoritative semantic cut. The server sends only
    // post-frontier incremental events after it.
    this.liveEvents = [];
    this.rebuild(false);
    const actions: LiveCompactorAction[] = [];
    for (const root of window.hotRoots) {
      if (root.kind !== "activity-subtree") continue;
      for (const node of root.nodes) {
        const transition = transitionChatProjection(this.current, node.event);
        this.current = transition.projection;
        for (const action of transition.actions) {
          if (action.type !== "text-changed") actions.push(action);
        }
      }
    }
    return actions;
  }

  applyHistoryPage(page: PublicHistoryPage): void {
    for (const root of page.roots) {
      if (root.state !== "sealed") {
        throw rootConflict("Public history pages may contain only sealed roots");
      }
    }
    const candidate = new Map(this.sealedRoots);
    this.installSealedRoots(candidate, page.roots);
    const projection = runLiveProjection({
      sealed: candidate,
      hot: this.hotRoots,
      liveEvents: this.liveEvents,
      requireComplete: true,
    });
    this.sealedRoots.clear();
    for (const [rootId, root] of candidate) this.sealedRoots.set(rootId, root);
    this.replaceProjection(projection);
  }

  reset(): void {
    this.projectionGeneration += 1;
    this.current = createChatProjection();
    this.sealedRoots.clear();
    this.hotRoots.clear();
    this.liveEvents = [];
    this.lineageId = null;
    this.pipelines.clear();
    this.dirtyParts.clear();
    this.pendingPresentationReconciliation = null;
  }

  setError(error: Error): void {
    this.current = { ...this.current, error };
  }

  materialize<TLocalPart extends ChatLocalPart = never>(): readonly ChatUIMessage<TLocalPart>[] {
    return materializeChatMessages<TLocalPart>(this.current, { allowPending: true });
  }

  *pull(finish = false): Operation<void> {
    this.reconcileProjectionPresentation();
    if (finish) {
      for (const entry of findTextParts(this.current)) {
        const pipeline = this.pipelines.get(entry.part.id);
        if (pipeline && !pipeline.isDone) {
          this.dirtyParts.set(entry.part.id, {
            messageId: entry.messageId,
            partId: entry.part.id,
            fallbackText: entry.part.text,
            done: true,
          });
        }
      }
    }

    const batch = [...this.dirtyParts.values()];
    this.dirtyParts.clear();
    const generation = this.projectionGeneration;
    for (const entry of batch) {
      const pipeline = this.pipelines.get(entry.partId);
      if (!pipeline || pipeline.isDone) {
        continue;
      }
      let frame: Frame;
      if (entry.done) {
        frame = yield* pipeline.flush();
      } else {
        frame = yield* pipeline.pull();
      }
      // A window/reset may replace `current` while presentation work is
      // suspended in a processor. That whole batch belongs to the old
      // projection; never apply it to the new one. The replacement's semantic
      // text remains authoritative and will be presented by its next pull.
      if (generation !== this.projectionGeneration) {
        return;
      }
      if (entry.done) {
        this.pipelines.delete(entry.partId);
      }
      const rendered = frame.blocks.map((block) => block.rendered || block.raw).join("");
      this.current = updateTextPartFrame(
        this.current,
        entry.messageId,
        entry.partId,
        frame,
        rendered || entry.fallbackText,
        entry.done,
      );
    }
  }

  /**
   * Install sealed roots, rejecting reuse of a root identity with different
   * content and reuse of a public position by a different root.
   */
  private installSealedRoots(
    target: Map<string, PublicProjectionRoot>,
    roots: readonly PublicProjectionRoot[],
  ): void {
    const byPosition = new Map<string, string>();
    for (const existing of target.values()) {
      byPosition.set(existing.position, existing.rootId);
    }
    for (const root of roots) {
      const current = target.get(root.rootId);
      if (current && JSON.stringify(current) !== JSON.stringify(root)) {
        throw rootConflict(`Public root ${root.rootId} conflicts with loaded history`);
      }
      const occupant = byPosition.get(root.position);
      if (occupant !== undefined && occupant !== root.rootId) {
        throw rootConflict(`Public position ${root.position} conflicts with loaded history`);
      }
      target.set(root.rootId, root);
      byPosition.set(root.position, root.rootId);
    }
  }

  private rebuild(replayLive: boolean): void {
    this.replaceProjection(
      runLiveProjection({
        sealed: this.sealedRoots,
        hot: this.hotRoots,
        liveEvents: replayLive ? this.liveEvents : [],
        requireComplete: false,
      }),
    );
  }

  /** Record an authoritative semantic replacement for the next presentation pull. */
  private replaceProjection(projection: ChatProjectionState): void {
    this.projectionGeneration += 1;
    this.pendingPresentationReconciliation = new Map(
      findTextParts(this.current).map((entry) => [
        `${entry.messageId}\u0000${entry.part.id}`,
        {
          text: entry.part.text,
          state: entry.part.state,
          frame: entry.part.frame,
          rendered: entry.part.rendered,
        },
      ]),
    );
    this.current = projection;
    this.pipelines.clear();
    this.dirtyParts.clear();
  }

  /** Reuse unchanged frames and queue changed authoritative text exactly once. */
  private reconcileProjectionPresentation(): void {
    const previous = this.pendingPresentationReconciliation;
    if (!previous) {
      return;
    }
    this.pendingPresentationReconciliation = null;
    for (const entry of findTextParts(this.current)) {
      const prior = previous.get(`${entry.messageId}\u0000${entry.part.id}`);
      if (
        prior?.text === entry.part.text &&
        prior.rendered.length > 0 &&
        prior.state === entry.part.state
      ) {
        this.current = updateTextPartFrame(
          this.current,
          entry.messageId,
          entry.part.id,
          prior.frame,
          prior.rendered,
          entry.part.state === "done",
        );
        continue;
      }
      if (entry.part.text.length === 0) {
        continue;
      }
      const pipeline = this.pipelineFactory(entry.part.kind, entry.part.id);
      pipeline.push(entry.part.text);
      this.pipelines.set(entry.part.id, pipeline);
      this.dirtyParts.set(entry.part.id, {
        messageId: entry.messageId,
        partId: entry.part.id,
        fallbackText: entry.part.text,
        done: entry.part.state === "done",
      });
    }
  }

  private bufferText(
    messageId: string,
    kind: "text" | "reasoning",
    delta: string,
    done: boolean,
  ): void {
    const candidates = findTextParts(this.current).filter(
      (entry) => entry.messageId === messageId && entry.part.kind === kind,
    );
    const candidate = candidates[candidates.length - 1];
    if (!candidate) {
      return;
    }
    let pipeline = this.pipelines.get(candidate.part.id);
    if (!pipeline) {
      pipeline = this.pipelineFactory(kind, candidate.part.id);
      this.pipelines.set(candidate.part.id, pipeline);
    }
    if (pipeline.isDone) {
      return;
    }
    if (delta) {
      pipeline.push(delta);
    }
    const previous = this.dirtyParts.get(candidate.part.id);
    this.dirtyParts.set(candidate.part.id, {
      messageId,
      partId: candidate.part.id,
      fallbackText: candidate.part.text,
      done: done || previous?.done === true,
    });
  }
}
