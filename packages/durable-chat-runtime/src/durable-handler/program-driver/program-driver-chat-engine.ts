import { resource, type Operation, type Stream } from "effection";
import { checkpointHotRoots } from "@sweatpants/history-store";
import { decodePublicProjectionRoot } from "@sweatpants/chat-core";

import { runWithTurnEventWriter } from "../model-sampling/turn-event-api.ts";
import { runProgramDriverChatActivation } from "./program-driver-chat-activation.ts";
import { composeProgramDriverChat } from "./program-driver-chat-composition.ts";
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
  for (;;) {
    const composition = composeProgramDriverChat(params);
    const head = yield* params.conversationStore.loadHead(params.conversationId);
    const checkpoint = head?.checkpoint
      ? yield* params.conversationStore.getCheckpoint(head.checkpoint)
      : null;
    // Only retained activities can receive replayed deltas. Completed activities
    // may have spilled to immutable history; replay must not resurrect them.
    const retainedActivityIds = new Set(
      (checkpoint ? checkpointHotRoots(checkpoint.payload) : []).flatMap((value) => {
        const root = decodePublicProjectionRoot(value);
        return root.kind === "activity-subtree"
          ? root.nodes.map((node) => node.activityRecordId)
          : [];
      }),
    );
    const activation = yield* runProgramDriverChatActivation(composition.activation);
    const presentationContext =
      activation.disposition.kind === "restart"
        ? { ...composition.presentation, continueAfterCancellation: true }
        : composition.presentation;
    const presented = yield* presentProgramDriverChatActivation(
      { ...presentationContext, retainedActivityIds },
      activation.report,
    );
    if (activation.disposition.kind === "present" && !presented.continueActivation) {
      return presented.events;
    }
    const {
      pluginAbort: _pluginAbort,
      continueAfterCancellation: _continueAfterCancellation,
      ...continuation
    } = params;
    params = continuation;
  }
}
