import { EventType, type Message } from "@ag-ui/core";
import type { Operation } from "effection";
import {
  appendAGUIMessage,
  createChatProjection,
  findTextParts,
  materializeChatMessages,
  projectionFromPublicRoots,
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
  type Frame,
  type FramePipeline,
  type FramePipelineFactory,
} from "@sweatpants/chat-core";

interface DirtyPart {
  readonly messageId: string;
  readonly partId: string;
  readonly fallbackText: string;
  readonly done: boolean;
}

export type LiveCompactorAction = Exclude<ChatProjectionAction, { readonly type: "text-changed" }>;

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
      this.sealedRoots.clear();
      this.hotRoots.clear();
      this.lineageId = null;
      this.liveEvents = [];
      this.pipelines.clear();
      this.dirtyParts.clear();
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
      for (const root of window.sealedCatchupRoots) {
        this.installSealedRoot(root);
      }
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
    const candidate = new Map(this.sealedRoots);
    for (const root of page.roots) {
      if (root.state !== "sealed") {
        throw Object.assign(new Error("Public history pages may contain only sealed roots"), {
          code: "public_root_conflict",
        });
      }
      this.installSealedRootInto(candidate, root);
    }
    const roots = [...candidate.values(), ...this.hotRoots.values()].filter(
      (root, index, all) => all.findIndex((other) => other.rootId === root.rootId) === index,
    );
    let projection = projectionFromPublicRoots(roots);
    for (const event of this.liveEvents) {
      projection = transitionChatProjection(projection, event).projection;
    }
    if (projection.pendingChildren.size > 0) {
      throw Object.assign(
        new Error(
          `Public history page is missing parents for ${[...projection.pendingChildren.keys()].join(
            ", ",
          )}`,
        ),
        { code: "public_history_parent_missing" },
      );
    }
    this.sealedRoots.clear();
    for (const [rootId, root] of candidate) this.sealedRoots.set(rootId, root);
    this.current = projection;
    this.pipelines.clear();
    this.dirtyParts.clear();
  }

  reset(): void {
    this.current = createChatProjection();
    this.sealedRoots.clear();
    this.hotRoots.clear();
    this.liveEvents = [];
    this.lineageId = null;
    this.pipelines.clear();
    this.dirtyParts.clear();
  }

  setError(error: Error): void {
    this.current = { ...this.current, error };
  }

  materialize<TLocalPart extends ChatLocalPart = never>(): readonly ChatUIMessage<TLocalPart>[] {
    return materializeChatMessages<TLocalPart>(this.current, { allowPending: true });
  }

  *pull(finish = false): Operation<void> {
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
    for (const entry of batch) {
      const pipeline = this.pipelines.get(entry.partId);
      if (!pipeline || pipeline.isDone) {
        continue;
      }
      let frame: Frame;
      if (entry.done) {
        frame = yield* pipeline.flush();
        this.pipelines.delete(entry.partId);
      } else {
        frame = yield* pipeline.pull();
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

  private installSealedRoot(root: PublicProjectionRoot): void {
    this.installSealedRootInto(this.sealedRoots, root);
  }

  private installSealedRootInto(
    roots: Map<string, PublicProjectionRoot>,
    root: PublicProjectionRoot,
  ): void {
    const current = roots.get(root.rootId);
    if (current && JSON.stringify(current) !== JSON.stringify(root)) {
      throw Object.assign(new Error(`Public root ${root.rootId} conflicts with loaded history`), {
        code: "public_root_conflict",
      });
    }
    for (const candidate of roots.values()) {
      if (candidate.position === root.position && candidate.rootId !== root.rootId) {
        throw Object.assign(
          new Error(`Public position ${root.position} conflicts with loaded history`),
          { code: "public_root_conflict" },
        );
      }
    }
    roots.set(root.rootId, root);
  }

  private rebuild(replayLive: boolean): void {
    const roots = [...this.sealedRoots.values(), ...this.hotRoots.values()].filter(
      (root, index, all) =>
        all.findIndex((candidate) => candidate.rootId === root.rootId) === index,
    );
    this.current = projectionFromPublicRoots(roots);
    if (replayLive) {
      for (const event of this.liveEvents) {
        this.current = transitionChatProjection(this.current, event).projection;
      }
    }
    this.pipelines.clear();
    this.dirtyParts.clear();
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
