import { EventType, type Message } from "@ag-ui/core";
import type { Operation } from "effection";
import {
  appendAGUIMessage,
  createChatProjection,
  findTextParts,
  materializeChatMessages,
  transitionChatProjection,
  updateTextPartFrame,
  type ChatLocalPart,
  type ChatUIMessage,
  type ChatProjectionAction,
  type ChatProjectionState,
  type AGUIEvent,
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
      this.pipelines.clear();
      this.dirtyParts.clear();
    }
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

  reset(): void {
    this.current = createChatProjection();
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
