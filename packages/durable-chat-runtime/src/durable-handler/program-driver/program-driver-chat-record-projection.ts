import { publicSubagentRunId } from "./program-driver-chat-attribution.ts";
import { EventType } from "@ag-ui/core";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import {
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import type { AGUIEvent } from "@sweatpants/chat-core";
import type { ChatJournalIndex } from "./program-driver-chat-journal-index.ts";
import { jsonRecord, toolFailureEnvelope } from "./program-driver-chat-projection-codecs.ts";
import {
  publicActivityToolStartSnapshots,
  publicElicitActivityDelta,
  publicToolMessageCompleted,
} from "./program-driver-chat-activity-projection.ts";

type RecordProjectionNote = { readonly kind: "events-projected"; readonly events: number };

function* projectRecordsProgram(
  records: DurableSemanticRecord[],
  index: ChatJournalIndex,
): ProjectionProgram<AGUIEvent[], RecordProjectionNote> {
  return yield* stage("project-events", function* () {
    const events = projectRecordsFromIndex(records, index);
    yield* note({ kind: "events-projected", events: events.length });
    return events;
  });
}

export function projectRecords(
  records: DurableSemanticRecord[],
  index: ChatJournalIndex,
): AGUIEvent[] {
  const outcome = runProjectionProgram(
    () => projectRecordsProgram(records, index),
    (error) => error,
  );
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function projectRecordsFromIndex(
  records: DurableSemanticRecord[],
  index: ChatJournalIndex,
): AGUIEvent[] {
  const events: AGUIEvent[] = [];
  const activeToolCalls = new Set<string>();
  let cancellationClosed = false;
  let errorClosed: DurableSemanticRecord | undefined;
  for (const recordEntry of records) {
    const subagentRunId = publicSubagentRunId(index, recordEntry.payload.taskId);
    const emit = (...values: AGUIEvent[]) =>
      events.push(
        ...values.map((event) =>
          subagentRunId === undefined ? event : { ...event, subagentRunId },
        ),
      );
    if (recordEntry.payload.type === "TaskClosed") {
      if (recordEntry.payload.outcome.status === "cancelled") {
        cancellationClosed = true;
      }
      if (recordEntry.payload.outcome.status === "error") {
        errorClosed = recordEntry;
      }
    }
    if (recordEntry.payload.type === "AssistantPartialAccepted") {
      const fact = recordEntry.payload.fact;
      emit(
        { type: EventType.TEXT_MESSAGE_START, messageId: fact.messageId, role: "assistant" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: fact.messageId,
          delta: fact.disposition === "interrupted" ? `${fact.text}\n\n[interrupted]` : fact.text,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: fact.messageId },
      );
      continue;
    }
    if (recordEntry.payload.type === "PullResolved") {
      const request = index.pullRequests.get(recordEntry.payload.pullId);
      if (request?.descriptor.kind === "elicit") {
        const completion =
          recordEntry.payload.outcome.status === "ok"
            ? jsonRecord(recordEntry.payload.outcome.value)
            : undefined;
        const cancelled =
          recordEntry.payload.outcome.status === "cancelled" || completion?.["action"] === "cancel";
        emit(
          publicElicitActivityDelta(
            `elicit:${recordEntry.payload.pullId}`,
            cancelled ? "cancelled" : "responded",
          ),
        );
      }
      continue;
    }
    if (recordEntry.payload.type !== "DurableEmission") {
      continue;
    }
    const descriptor = recordEntry.payload.descriptor;
    const payload = jsonRecord(descriptor.payload);
    if (!payload) {
      continue;
    }
    if (descriptor.eventType === "assistant_text" && typeof payload["text"] === "string") {
      const messageId = index.modelMessageIds.get(recordEntry) ?? null;
      if (!messageId) {
        continue;
      }
      emit(
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: payload["text"] },
        { type: EventType.TEXT_MESSAGE_END, messageId },
      );
    }
    if (
      descriptor.eventType === "tool_started" &&
      typeof payload["callId"] === "string" &&
      typeof payload["tool"] === "string"
    ) {
      activeToolCalls.add(payload["callId"]);
      emit(
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: payload["callId"],
          toolCallName: payload["tool"],
          parentMessageId: `message:${recordEntry.payload.taskId}:${payload["callId"]}`,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: payload["callId"],
          delta: JSON.stringify(payload["input"] ?? null),
        },
        ...publicActivityToolStartSnapshots(index, recordEntry, payload),
      );
    }
    if (
      descriptor.eventType === "tool_completed" &&
      typeof payload["callId"] === "string" &&
      typeof payload["tool"] === "string"
    ) {
      const activeInThisRun = activeToolCalls.delete(payload["callId"]);
      const startedPreviously = index.previousToolStarts.get(payload["callId"]);
      if (activeInThisRun) {
        emit({ type: EventType.TOOL_CALL_END, toolCallId: payload["callId"] });
      } else if (!startedPreviously) {
        emit(
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: payload["callId"],
            toolCallName: payload["tool"],
            parentMessageId: `message:${recordEntry.payload.taskId}:${payload["callId"]}`,
          },
          ...publicActivityToolStartSnapshots(index, recordEntry, payload),
          { type: EventType.TOOL_CALL_END, toolCallId: payload["callId"] },
        );
      }
      const failed = payload["failed"] === true;
      const result = payload["result"] ?? null;
      emit({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${payload["callId"]}`,
        toolCallId: payload["callId"],
        content: JSON.stringify(
          failed
            ? {
                status: "error",
                errorText: toolFailureEnvelope(result).error.message,
                detail: result,
              }
            : { status: "ok", output: result },
        ),
        role: "tool",
      });
      emit(
        publicToolMessageCompleted(
          index.toolMessageIds.get(payload["callId"]) ??
            `message:${recordEntry.payload.taskId}:${payload["callId"]}`,
        ),
      );
    }
  }

  if (cancellationClosed) {
    for (const pending of index.unfinishedToolCalls) {
      const partial = index.cancellationPartials.get(pending.callId);
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pending.callId });
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${pending.callId}:cancelled`,
        toolCallId: pending.callId,
        content: JSON.stringify({
          status: "cancelled",
          /* CONDITIONAL-SPREAD: Omit absent partial from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
          ...(partial ? { partial } : {}),
        }),
        role: "tool",
      });
      const owner = index.toolMessageIds.get(pending.callId);
      if (owner) {
        events.push(publicToolMessageCompleted(owner));
      }
    }
  }
  const errored = errorClosed;
  if (errored?.payload.type === "TaskClosed" && errored.payload.outcome.status === "error") {
    for (const pending of index.unfinishedToolCalls) {
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pending.callId });
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${pending.callId}:error`,
        toolCallId: pending.callId,
        content: JSON.stringify({
          status: "interrupted",
          outcome: "unknown",
          error: errored.payload.outcome.error,
        }),
        role: "tool",
      });
      const owner = index.toolMessageIds.get(pending.callId);
      if (owner) {
        events.push(publicToolMessageCompleted(owner));
      }
    }
  }
  return events;
}
