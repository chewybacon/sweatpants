/**
 * Server-internal response-tail event stream.
 *
 * The tail is delivery-only: this bridge projects strict public values and
 * appends live events to the Host-owned writer. Durable conversation,
 * interrupt, and model authority live in their dedicated stores.
 */
import { resource, type Operation, type Stream } from "effection";
import type { TokenBufferWriter } from "@sweatpants/durable-streams";
import type { ConversationStreamEvent as StreamEvent } from "@sweatpants/chat-core";
import { registerInterruptsFromRunFinished } from "../interrupts/index.ts";
import { toStrictPublicEvent } from "../projection.ts";

export type TurnEventSink = (event: StreamEvent) => Operation<void>;
export type ChatEngineSource =
  | Stream<StreamEvent, void>
  | ((turnEventSink: TurnEventSink) => Stream<StreamEvent, void>);

export function createEmptyChatEngine(): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        return { done: true, value: undefined };
      },
    });
  });
}

export function createSerializedEventStream(
  engine: ChatEngineSource,
  initialEvents: StreamEvent[] = [],
  options?: { responseTokenBuffer?: TokenBufferWriter<StreamEvent> },
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    let initialIndex = 0;

    const turnEventSink: TurnEventSink = function* (rawEvent) {
      if (!options?.responseTokenBuffer) {
        throw new Error("Live event delivery requires the Host-owned token buffer");
      }
      registerInterruptsFromRunFinished(rawEvent);
      const event = toStrictPublicEvent(rawEvent);
      if (event) {
        yield* options.responseTokenBuffer.append([event]);
      }
    };
    const selectedEngine = typeof engine === "function" ? engine(turnEventSink) : engine;
    const subscription = yield* selectedEngine;

    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        while (initialIndex < initialEvents.length) {
          const rawEvent = initialEvents[initialIndex++]!;
          registerInterruptsFromRunFinished(rawEvent);
          const event = toStrictPublicEvent(rawEvent);
          if (event) {
            return { done: false, value: event };
          }
        }

        while (true) {
          const result = yield* subscription.next();
          if (result.done) {
            return { done: true, value: undefined };
          }
          registerInterruptsFromRunFinished(result.value);
          const event = toStrictPublicEvent(result.value);
          if (event) {
            return { done: false, value: event };
          }
        }
      },
    });
  });
}
