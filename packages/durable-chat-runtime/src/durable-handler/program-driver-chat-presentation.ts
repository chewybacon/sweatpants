import { EventType, type AGUIEvent } from "@ag-ui/core";
import { type Operation } from "effection";
import { assertJson } from "@sweatpants/foundation";
import { CONVERSATION_AUTHORITY_FRAME_TYPE } from "@sweatpants/chat-core";

import {
  pendingElicit,
  pendingToolCallId,
  projectInterrupt,
  projectRecords,
  publicActivityElicitSnapshots,
} from "./program-driver-chat-projection.ts";
import type {
  ChatActivationReport,
  ProgramDriverChatEngineParams,
  StreamEvent,
} from "./program-driver-chat-types.ts";

/** Pure-history presentation and product publication; receives no Authority capability. */
export function* presentProgramDriverChatActivation(
  params: ProgramDriverChatEngineParams,
  report: ChatActivationReport,
  continueActivation: (params: ProgramDriverChatEngineParams) => Operation<StreamEvent[]>,
): Operation<StreamEvent[]> {
  const {
    before,
    after,
    outcome,
    liveMessageIds,
    endedLiveMessageIds,
    cancellationFenceLost,
    replacementQueued,
  } = report;
  const events: StreamEvent[] = [];
  const projected = projectRecords(after.slice(before.length), after);
  events.push(
    ...projected.filter((event) => {
      if (
        event.type !== EventType.TEXT_MESSAGE_START &&
        event.type !== EventType.TEXT_MESSAGE_CONTENT &&
        event.type !== EventType.TEXT_MESSAGE_END
      ) {
        return true;
      }
      if (!liveMessageIds.has(event.messageId)) {
        return true;
      }
      return event.type === EventType.TEXT_MESSAGE_END && !endedLiveMessageIds.has(event.messageId);
    }),
  );
  if (outcome.state === "completed") {
    const terminalEvent: AGUIEvent = {
      type: EventType.RUN_FINISHED,
      ...params.agUiRun,
      outcome: { type: "success" },
    };
    const published = yield* params.publishTerminal({
      outcome: outcome.value,
      disposition: "completed",
      events: [...projected, terminalEvent],
    });
    events.push(
      ...(published.window ? [published.window] : []),
      { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
      terminalEvent,
    );
  } else if (outcome.state === "parked") {
    // Bounded frontier (REQ-028): surface every participant-addressable slot
    // a fork group parked on; a single park degrades to its one pull.
    const slotPullIds =
      outcome.slots === undefined ? [outcome.pullId] : outcome.slots.map((slot) => slot.pullId);
    const pendings = slotPullIds
      .map((slotPullId) => pendingElicit(after, slotPullId))
      .filter((pending): pending is NonNullable<typeof pending> => pending !== undefined);
    if (pendings.length > 0) {
      for (const pending of pendings) {
        const pendingCallId = pendingToolCallId(after, pending);
        if (pendingCallId) {
          events.push({ type: EventType.TOOL_CALL_END, toolCallId: pendingCallId });
        }
        const interrupt = projectInterrupt(after, pending, params);
        events.push(...publicActivityElicitSnapshots(after, pending, interrupt));
        events.push(interrupt);
      }
    } else {
      events.push({
        type: EventType.RUN_ERROR,
        code: "PROGRAM_PARKED",
        message: "Program parked without a public input request",
      });
    }
    if (params.publishCheckpoint) {
      const published = yield* params.publishCheckpoint({ events });
      const terminalIndex = Math.max(0, events.length - 1);
      events.splice(terminalIndex, 0, ...(published.window ? [published.window] : []), {
        type: CONVERSATION_AUTHORITY_FRAME_TYPE,
        authority: published.authority,
      });
    }
  } else if (outcome.state === "cancelled") {
    if (cancellationFenceLost) {
      const terminalEvent: StreamEvent = {
        type: EventType.RUN_ERROR,
        code: "PROGRAM_CANCELLED",
        message: "Program was cancelled",
      };
      const published = yield* params.publishTerminal({
        outcome: { code: "PROGRAM_CANCELLED", message: "Program was cancelled" },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push(
        ...(published.window ? [published.window] : []),
        { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
        terminalEvent,
      );
    } else if (params.continueAfterCancellation || replacementQueued) {
      const {
        pluginAbort: _pluginAbort,
        continueAfterCancellation: _continueAfterCancellation,
        ...continuationParams
      } = params;
      events.push(...(yield* continueActivation(continuationParams)));
    } else {
      const terminalEvent: AGUIEvent = {
        type: EventType.RUN_ERROR,
        code: "PROGRAM_CANCELLED",
        message: params.pluginAbort?.reason ?? "Program was cancelled",
      };
      const published = yield* params.publishTerminal({
        outcome: {
          code: "PROGRAM_CANCELLED",
          message: params.pluginAbort?.reason ?? "Program was cancelled",
        },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push(
        ...(published.window ? [published.window] : []),
        { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
        terminalEvent,
      );
    }
  } else {
    const terminalEvent: AGUIEvent = {
      type: EventType.RUN_ERROR,
      code: outcome.error.code,
      message: outcome.error.message,
    };
    const published = yield* params.publishTerminal({
      outcome: assertJson(outcome.error),
      disposition: "failed",
      events: [...projected, terminalEvent],
    });
    events.push(
      ...(published.window ? [published.window] : []),
      { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
      terminalEvent,
    );
  }

  return events;
}
