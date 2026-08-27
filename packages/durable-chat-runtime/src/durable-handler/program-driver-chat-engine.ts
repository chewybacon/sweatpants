import { resource, type Operation, type Stream } from "effection";

import { runWithTurnEventWriter } from "./model-sampling/turn-event-api.ts";
import { runProgramDriverChatActivation } from "./program-driver-chat-activation.ts";
import { presentProgramDriverChatActivation } from "./program-driver-chat-presentation.ts";
import type { ProgramDriverChatEngineParams, StreamEvent } from "./program-driver-chat-types.ts";

/**
 * Readable product composition root.
 *
 * Execution returns private durable facts. Presentation receives those facts
 * without an Authority capability and publishes the public view. The two
 * domains compose here and nowhere deeper.
 */
export function createProgramDriverChatEngine(
  params: ProgramDriverChatEngineParams,
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    let events: StreamEvent[] | undefined;
    let cursor = 0;
    let failure: Error | undefined;
    try {
      yield* provide({
        *next(): Operation<IteratorResult<StreamEvent, void>> {
          events ??= yield* runWithTurnEventWriter(
            params.liveEvent ? { emit: params.liveEvent } : undefined,
            () => activateAndPresent(params),
          );
          const event = events[cursor];
          if (!event) return { done: true, value: undefined };
          cursor += 1;
          return { done: false, value: event };
        },
      });
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      params.onLiveActivationSettled?.(failure);
    }
  });
}

function* activateAndPresent(params: ProgramDriverChatEngineParams): Operation<StreamEvent[]> {
  const report = yield* runProgramDriverChatActivation(params);
  return yield* presentProgramDriverChatActivation(params, report, activateAndPresent);
}
