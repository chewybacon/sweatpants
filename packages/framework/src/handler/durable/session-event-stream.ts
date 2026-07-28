/**
 * Serialized session event stream.
 *
 * Bridges the chat engine to the Host-owned response token buffer: assigns
 * LSNs, projects events to their public wire form, registers interrupts from
 * RUN_FINISHED markers, and persists conversation checkpoints and interrupt
 * state as frames are consumed.
 */
import { resource, type Operation, type Stream } from "effection";
import type {
  TokenBufferStore,
  TokenBufferWriter,
} from "@sweatpants/durable-chat-runtime/response-streams";
import type { StreamEvent } from "@sweatpants/durable-chat-runtime/handler/types";
import type { DurableFrame } from "@sweatpants/chat-core";
import { recordConversationCheckpoint } from "./conversation-index.ts";
import {
  interruptRecordsForThread,
  registerInterruptsFromRunFinished,
} from "./interrupt-registry.ts";
import { recordThreadInterruptState } from "./interrupt-store.ts";
import {
  buildCheckpointSnapshotEventsFromFrames,
  toStrictPublicEvent,
} from "./conversation-projection.ts";

export type LiveEventSink = (event: StreamEvent) => Operation<void>;
export type ChatEngineSource =
  | Stream<StreamEvent, void>
  | ((liveEvent: LiveEventSink) => Stream<StreamEvent, void>);

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
  options?: {
    conversationId?: string;
    checkpointStore?: TokenBufferStore<string>;
    responseTokenBuffer?: TokenBufferWriter<StreamEvent>;
  },
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    let initialIndex = 0;
    let emittedCount = 0;
    let checkpointPersisted = false;
    const emittedFrames: DurableFrame[] = [];

    function* persistCheckpointIfNeeded(): Operation<void> {
      if (checkpointPersisted || !options?.conversationId || !options.checkpointStore) {
        return;
      }
      checkpointPersisted = true;
      const checkpointEvents = yield* buildCheckpointSnapshotEventsFromFrames(emittedFrames);
      if (checkpointEvents.length === 0) {
        return;
      }
      yield* recordConversationCheckpoint(
        options.checkpointStore,
        options.conversationId,
        JSON.stringify(checkpointEvents),
      );
    }

    function* persistInterruptStateIfNeeded(rawEvent: StreamEvent): Operation<void> {
      if (
        rawEvent.type !== "RUN_FINISHED" ||
        !options?.conversationId ||
        !options.checkpointStore
      ) {
        return;
      }

      yield* recordThreadInterruptState(
        options.checkpointStore,
        options.conversationId,
        interruptRecordsForThread(options.conversationId),
      );
    }

    const liveEvent: LiveEventSink = function* (rawEvent) {
      if (!options?.responseTokenBuffer) {
        throw new Error("Live event delivery requires the Host-owned token buffer");
      }
      registerInterruptsFromRunFinished(rawEvent);
      yield* persistInterruptStateIfNeeded(rawEvent);
      const event = toStrictPublicEvent(rawEvent);
      if (!event) {
        return;
      }
      const lsn = yield* options.responseTokenBuffer.append([event]);
      emittedCount = Math.max(emittedCount, lsn);
      emittedFrames.push({ lsn, event });
    };
    const selectedEngine = typeof engine === "function" ? engine(liveEvent) : engine;
    const subscription = yield* selectedEngine;

    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        while (initialIndex < initialEvents.length) {
          const rawEvent = initialEvents[initialIndex++]!;
          registerInterruptsFromRunFinished(rawEvent);
          yield* persistInterruptStateIfNeeded(rawEvent);
          const event = toStrictPublicEvent(rawEvent);
          if (!event) {
            continue;
          }
          emittedFrames.push({ lsn: ++emittedCount, event });
          return { done: false, value: event };
        }

        while (true) {
          const result = yield* subscription.next();
          if (result.done) {
            yield* persistCheckpointIfNeeded();
            return { done: true, value: undefined };
          }
          registerInterruptsFromRunFinished(result.value);
          yield* persistInterruptStateIfNeeded(result.value);
          const event = toStrictPublicEvent(result.value);
          if (!event) {
            continue;
          }
          emittedFrames.push({ lsn: ++emittedCount, event });
          return { done: false, value: event };
        }
      },
    });
  });
}
