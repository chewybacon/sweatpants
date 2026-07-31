import { createContext, type Operation } from "effection";
import { createApi } from "effection/experimental";
import type { ChatSessionStreamEvent as StreamEvent } from "@sweatpants/chat-core";

export interface TurnEventWriter {
  emit(event: StreamEvent): Operation<void>;
}

const TurnEventWriterContext = createContext<TurnEventWriter | undefined>(
  "durable-chat:turn-event-writer",
  undefined,
);

/** Middleware-aware live Turn output. AG-UI remains produced by the runtime. */
export const TurnEventApi = createApi("durable-chat:turn-events", {
  *emit(event: StreamEvent): Operation<void> {
    const writer = yield* TurnEventWriterContext.get();
    if (writer) yield* writer.emit(event);
  },
  *installed(): Operation<boolean> {
    return (yield* TurnEventWriterContext.get()) !== undefined;
  },
});

export function runWithTurnEventWriter<T>(
  writer: TurnEventWriter | undefined,
  operation: () => Operation<T>,
): Operation<T> {
  return TurnEventWriterContext.with(writer, operation);
}
