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

import { publicActivityElicitSnapshots } from "./program-driver-chat-activity-projection.ts";
import { pendingToolCallId, projectInterrupt } from "./program-driver-chat-interrupt-projection.ts";
import { indexChatJournal, pendingElicit } from "./program-driver-chat-journal-index.ts";
import { recordsForPublication } from "./program-driver-chat-publication.ts";
import { projectRecords } from "./program-driver-chat-record-projection.ts";
import type { ChatActivationReport, StreamEvent } from "./program-driver-chat-types.ts";

/** Pure-history presentation and product publication; receives no Authority capability. */
export interface ChatPresentationContext {
  readonly agUiRun: AgUiRunMetadata;
  readonly toolInventory: readonly ToolInventoryEntry[];
  readonly continueAfterCancellation: boolean;
  readonly cancellationMessage: string;
  readonly publishedOwners: ReadonlySet<string>;
  readonly retainedActivityIds: ReadonlySet<string>;
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
  const { before, after, outcome, liveMessageIds, endedLiveMessageIds, cancellationFenceLost } =
    report;
  const events: StreamEvent[] = [];
  const projection = indexChatJournal(after);
  const projected = projectRecords(
    recordsForPublication(before, after, context.publishedOwners, context.retainedActivityIds),
    projection,
  );
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
    const parkedEvents: StreamEvent[] = [];
    // Bounded frontier (REQ-028): surface every participant-addressable slot
    // a fork group parked on, including the single-park case.
    const slotPullIds = outcome.slots.map((slot) => slot.pullId);
    const pendings = slotPullIds
      .map((slotPullId) => pendingElicit(projection, slotPullId))
      .filter((pending): pending is NonNullable<typeof pending> => pending !== undefined);
    if (pendings.length > 0) {
      for (const pending of pendings) {
        parkedEvents.push({
          type: EventType.TOOL_CALL_END,
          toolCallId: pendingToolCallId(projection, pending),
        });
        const interrupt = projectInterrupt(projection, pending, {
          agUiRun: context.agUiRun,
          toolInventory: context.toolInventory,
        });
        parkedEvents.push(...publicActivityElicitSnapshots(projection, pending, interrupt));
        parkedEvents.push(interrupt);
      }
    } else {
      parkedEvents.push({
        type: EventType.RUN_ERROR,
        code: "PROGRAM_PARKED",
        message: "Program parked without a public input request",
      });
    }
    events.push(...parkedEvents);
    if (context.publishCheckpoint) {
      // Live delivery deduplicates streamed text, but durable history needs it.
      const published = yield* context.publishCheckpoint({
        events: [...projected, ...parkedEvents],
      });
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
    } else if (context.continueAfterCancellation) {
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
