import type { Operation } from "effection";
import { createSignal, each } from "effection";
import type { ChatSessionStreamEvent, Streamer, StreamResult } from "./types.ts";

export interface TestStreamerControls {
  emit(event: ChatSessionStreamEvent): Operation<void>;
  complete(finalText: string): Operation<void>;
  error(message: string): Operation<void>;
  waitForStart(): Promise<void>;
}
export interface TestStreamer {
  streamer: Streamer;
  controls: TestStreamerControls;
}

export function createTestStreamer(): TestStreamer {
  type InternalEvent = ChatSessionStreamEvent | { type: "__complete__"; text: string };
  const signal = createSignal<InternalEvent, void>();
  let resolveStart!: () => void;
  const startPromise = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });

  const streamer: Streamer = function* (_messages, events): Operation<StreamResult> {
    const threadId = "test-thread";
    const runId = crypto.randomUUID();
    let finalText = "";
    resolveStart();
    yield* events.send({ type: "RUN_STARTED", threadId, runId });

    for (const event of yield* each(signal)) {
      if (event.type === "__complete__") {
        finalText = event.text || finalText;
        if (event.text) {
          const messageId = `assistant:${runId}`;
          yield* events.send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
          yield* events.send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: event.text });
          yield* events.send({ type: "TEXT_MESSAGE_END", messageId });
        }
        yield* events.send({ type: "RUN_FINISHED", threadId, runId, outcome: { type: "success" } });
        break;
      }
      if (event.type === "TEXT_MESSAGE_CONTENT") {
        finalText += event.delta;
      }
      yield* events.send(event);
      if (event.type === "RUN_ERROR") {
        throw new Error(event.message);
      }
      yield* each.next();
    }
    return { type: "complete", text: finalText };
  };

  return {
    streamer,
    controls: {
      *emit(event) {
        signal.send(event);
      },
      *complete(text) {
        signal.send({ type: "__complete__", text });
      },
      *error(message) {
        signal.send({ type: "RUN_ERROR", message });
      },
      waitForStart() {
        return startPromise;
      },
    },
  };
}

export function createImmediateStreamer(
  sourceEvents: ChatSessionStreamEvent[],
  finalText: string,
): Streamer {
  return function* (_messages, events) {
    const threadId = "test-thread";
    const runId = crypto.randomUUID();
    yield* events.send({ type: "RUN_STARTED", threadId, runId });
    for (const event of sourceEvents) {
      yield* events.send(event);
    }
    if (finalText) {
      const messageId = `assistant:${runId}`;
      yield* events.send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      yield* events.send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: finalText });
      yield* events.send({ type: "TEXT_MESSAGE_END", messageId });
    }
    yield* events.send({ type: "RUN_FINISHED", threadId, runId, outcome: { type: "success" } });
    return { type: "complete", text: finalText };
  };
}
