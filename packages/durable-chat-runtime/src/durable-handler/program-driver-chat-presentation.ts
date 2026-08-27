import { EventType, type AGUIEvent } from "@ag-ui/core";
import { type Operation } from "effection";
import { assertJson, type Json } from "@sweatpants/foundation";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  type AgUiRunMetadata,
  type ConversationAuthority,
  type ConversationWindowFrame,
} from "@sweatpants/chat-core";
import type { ToolInventoryEntry } from "@sweatpants/tool-runtime";

import {
  pendingElicit,
  publicActivityElicitSnapshots,
} from "./program-driver-chat-activity-projection.ts";
import { pendingToolCallId, projectInterrupt } from "./program-driver-chat-interrupt-projection.ts";
import { projectRecords } from "./program-driver-chat-record-projection.ts";
import type { ChatActivationReport, StreamEvent } from "./program-driver-chat-types.ts";

/** Pure-history presentation and product publication; receives no Authority capability. */
export interface ChatPresentationContext {
  readonly agUiRun: AgUiRunMetadata;
  readonly toolInventory: readonly ToolInventoryEntry[];
  readonly continueAfterCancellation: boolean;
  readonly cancellationMessage: string;
  readonly publishCheckpoint?: (request: { events: readonly StreamEvent[] }) => Operation<{
    readonly authority: ConversationAuthority;
    readonly window?: ConversationWindowFrame;
  }>;
  readonly publishTerminal: (request: {
    outcome: Json;
    disposition: "completed" | "failed" | "cancelled";
    events: readonly StreamEvent[];
  }) => Operation<{
    readonly authority: ConversationAuthority;
    readonly window?: ConversationWindowFrame;
  }>;
}

export interface ChatPresentationResult {
  readonly events: StreamEvent[];
  readonly continueActivation: boolean;
}

export function* presentProgramDriverChatActivation(
  context: ChatPresentationContext,
  report: ChatActivationReport,
): Operation<ChatPresentationResult> {
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
      ...context.agUiRun,
      outcome: { type: "success" },
    };
    const published = yield* context.publishTerminal({
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
        const interrupt = projectInterrupt(after, pending, {
          agUiRun: context.agUiRun,
          toolInventory: context.toolInventory,
        });
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
    if (context.publishCheckpoint) {
      const published = yield* context.publishCheckpoint({ events });
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
      const published = yield* context.publishTerminal({
        outcome: { code: "PROGRAM_CANCELLED", message: "Program was cancelled" },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push(
        ...(published.window ? [published.window] : []),
        { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
        terminalEvent,
      );
    } else if (context.continueAfterCancellation || replacementQueued) {
      return { events, continueActivation: true };
    } else {
      const terminalEvent: AGUIEvent = {
        type: EventType.RUN_ERROR,
        code: "PROGRAM_CANCELLED",
        message: context.cancellationMessage,
      };
      const published = yield* context.publishTerminal({
        outcome: {
          code: "PROGRAM_CANCELLED",
          message: context.cancellationMessage,
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
    const published = yield* context.publishTerminal({
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

  return { events, continueActivation: false };
}
