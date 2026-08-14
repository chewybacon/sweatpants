/**
 * Serialized session event stream.
 *
 * Bridges the chat engine to the Host-owned response token buffer: assigns
 * LSNs, projects events to their public wire form, registers interrupts from
 * RUN_FINISHED markers, and persists conversation checkpoints and interrupt
 * state as frames are consumed.
 */
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { resource, type Operation, type Stream } from "effection";
import type { TokenBufferStore, TokenBufferWriter } from "@sweatpants/durable-streams";
import type { StreamEvent } from "../handler/types.ts";
import { isConversationAuthorityFrame, type DurableFrame } from "@sweatpants/chat-core";
import {
  readLatestConversationCheckpoint,
  recordConversationCheckpoint,
} from "./conversation-index.ts";
import {
  interruptRecordsForThread,
  registerInterruptsFromRunFinished,
} from "../interrupts/index.ts";
import { recordThreadInterruptState } from "../interrupts/index.ts";
import { buildCheckpointSnapshotEventsFromFrames, toStrictPublicEvent } from "../projection.ts";
import {
  decodeConversationCheckpoint,
  encodeConversationCheckpoint,
} from "./conversation-checkpoint.ts";

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
  options?: {
    conversationId?: string;
    checkpointStore?: TokenBufferStore<string>;
    responseTokenBuffer?: TokenBufferWriter<StreamEvent>;
    onCheckpointError?: (error: unknown) => void;
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
      try {
        const previousCheckpoint = yield* readLatestConversationCheckpoint(
          options.checkpointStore,
          options.conversationId,
        );
        const previousEvents = previousCheckpoint
          ? decodeConversationCheckpoint(previousCheckpoint)
          : [];
        const checkpointFrames: DurableFrame[] = [
          ...previousEvents.map((event, index) => ({ lsn: index + 1, event })),
          ...emittedFrames,
        ];
        const checkpointEvents = yield* buildCheckpointSnapshotEventsFromFrames(checkpointFrames);
        const presentationEvents = checkpointEvents.filter(
          (event): event is AGUIEvent => !isConversationAuthorityFrame(event),
        );
        if (presentationEvents.length === 0) {
          return;
        }
        yield* recordConversationCheckpoint(
          options.checkpointStore,
          options.conversationId,
          encodeConversationCheckpoint(presentationEvents),
        );
      } catch (error) {
        try {
          options.onCheckpointError?.(error);
        } catch {
          // Checkpoint observability cannot fail the completed chat turn.
        }
      }
    }

    function* persistInterruptStateIfNeeded(rawEvent: StreamEvent): Operation<void> {
      if (
        rawEvent.type !== EventType.RUN_FINISHED ||
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

    const turnEventSink: TurnEventSink = function* (rawEvent) {
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
    const selectedEngine = typeof engine === "function" ? engine(turnEventSink) : engine;
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
