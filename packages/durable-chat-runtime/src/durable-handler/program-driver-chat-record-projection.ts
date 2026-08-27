import { EventType } from "@ag-ui/core";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import {
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import { combine, fold, mapFold, runFold, type Fold, type Json } from "@sweatpants/foundation";
import type { StreamEvent } from "./program-driver-chat-types.ts";
import { jsonRecord } from "./program-driver-chat-projection-values.ts";
import {
  publicActivityToolStartSnapshots,
  publicElicitActivityDelta,
} from "./program-driver-chat-activity-projection.ts";

type PullRequestedRecord = Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }>;

/** Injective, allocation-cheap composite key. Ids are opaque, so length-prefix. */
function pullKey(taskId: string, pullId: string): string {
  return `${taskId.length}:${taskId}:${pullId}`;
}

type RecordProjectionNote =
  | {
      readonly kind: "records-indexed";
      readonly records: number;
      readonly pullRequests: number;
      readonly unfinishedTools: number;
    }
  | { readonly kind: "events-projected"; readonly events: number };

interface RecordProjectionIndex {
  readonly pullRequests: ReadonlyMap<string, PullRequestedRecord>;
  readonly previousToolStarts: ReadonlyMap<string, Record<string, Json>>;
  readonly unfinishedToolCalls: readonly { callId: string; tool: string }[];
  readonly cancellationPartials: ReadonlyMap<string, Json>;
  /** Public assistant message identity for each durable emission. */
  readonly modelMessageIds: ReadonlyMap<DurableSemanticRecord, string | null>;
  readonly cancellationClosed: boolean;
  readonly errorClosed: DurableSemanticRecord | undefined;
}

function indexRecordProjection(
  records: readonly DurableSemanticRecord[],
  allRecords: readonly DurableSemanticRecord[],
): RecordProjectionIndex {
  const scanned = runFold(allRecordsIndexFold, allRecords);
  const terminal = runFold(terminalOutcomeFold, records);
  return { ...scanned, ...terminal };
}

/** Pulls by id; first occurrence wins. */
const pullRequestsFold: Fold<
  DurableSemanticRecord,
  ReadonlyMap<string, PullRequestedRecord>
> = fold(() => {
  const pulls = new Map<string, PullRequestedRecord>();
  return {
    step(record) {
      if (record.payload.type === "PullRequested" && !pulls.has(record.payload.pullId)) {
        pulls.set(record.payload.pullId, record.payload);
      }
    },
    done: () => pulls,
  };
});

/** Started/completed pairing resolves in `done()`, not in a second pass. */
const toolLifecycleFold: Fold<
  DurableSemanticRecord,
  {
    readonly previousToolStarts: ReadonlyMap<string, Record<string, Json>>;
    readonly unfinishedToolCalls: readonly { callId: string; tool: string }[];
  }
> = fold(() => {
  const started = new Map<string, string>();
  const completed = new Set<string>();
  const previousToolStarts = new Map<string, Record<string, Json>>();
  return {
    step(record) {
      if (record.payload.type !== "DurableEmission") return;
      const payload = jsonRecord(record.payload.descriptor.payload);
      if (!payload || typeof payload["callId"] !== "string") return;
      if (
        record.payload.descriptor.eventType === "tool_started" &&
        typeof payload["tool"] === "string"
      ) {
        started.set(payload["callId"], payload["tool"]);
        previousToolStarts.set(payload["callId"], payload);
      }
      if (record.payload.descriptor.eventType === "tool_completed") {
        completed.add(payload["callId"]);
      }
    },
    done: () => ({
      previousToolStarts,
      unfinishedToolCalls: [...started]
        .filter(([callId]) => !completed.has(callId))
        .map(([callId, tool]) => ({ callId, tool })),
    }),
  };
});

/** Cancelled partials, keyed by pull id; joined against pulls in `done()`. */
const cancellationLinksFold: Fold<
  DurableSemanticRecord,
  readonly { readonly pullId: string; readonly partial: Json }[]
> = fold(() => {
  const links: { readonly pullId: string; readonly partial: Json }[] = [];
  return {
    step(record) {
      const payload = record.payload;
      if (payload.type !== "PullResolved" || payload.outcome.status !== "cancelled") return;
      if (payload.outcome.partial === undefined) return;
      links.push({ pullId: payload.pullId, partial: payload.outcome.partial });
    },
    done: () => links,
  };
});

const preparedFold: Fold<DurableSemanticRecord, ReadonlyMap<string, string>> = fold(() => {
  const prepared = new Map<string, string>();
  return {
    step(record) {
      if (record.payload.type === "ModelContextPrepared") {
        prepared.set(
          pullKey(record.payload.taskId, record.payload.pullId),
          record.payload.fact.publicMessageId,
        );
      }
    },
    done: () => prepared,
  };
});

/**
 * Links each emission to the most recent preceding model pull for its task.
 * A preparation may be journaled after its emission, so the link is captured
 * positionally here and resolved against `prepared` in `done()`.
 */
const modelLinksFold: Fold<
  DurableSemanticRecord,
  ReadonlyMap<DurableSemanticRecord, PullRequestedRecord | null>
> = fold(() => {
  const lastModelPullByTask = new Map<string, PullRequestedRecord>();
  const links = new Map<DurableSemanticRecord, PullRequestedRecord | null>();
  return {
    step(record) {
      const payload = record.payload;
      if (payload.type === "PullRequested" && payload.descriptor.kind === "sample") {
        lastModelPullByTask.set(payload.taskId, payload);
        return;
      }
      if (payload.type !== "DurableEmission") return;
      links.set(record, lastModelPullByTask.get(payload.taskId) ?? null);
    },
    done: () => links,
  };
});

/** Every index over the full journal, in one traversal. */
const allRecordsIndexFold = mapFold(
  combine({
    pullRequests: pullRequestsFold,
    toolLifecycle: toolLifecycleFold,
    cancellationLinks: cancellationLinksFold,
    prepared: preparedFold,
    modelLinks: modelLinksFold,
  }),
  ({ pullRequests, toolLifecycle, cancellationLinks, prepared, modelLinks }) => ({
    pullRequests,
    previousToolStarts: toolLifecycle.previousToolStarts,
    unfinishedToolCalls: toolLifecycle.unfinishedToolCalls,
    cancellationPartials: new Map(
      cancellationLinks.flatMap(({ pullId, partial }) => {
        const request = pullRequests.get(pullId);
        return request?.descriptor.kind === "effect" &&
          request.descriptor.resolver.route !== undefined
          ? ([[request.descriptor.resolver.route, partial]] as const)
          : [];
      }),
    ) as ReadonlyMap<string, Json>,
    modelMessageIds: new Map(
      [...modelLinks].map(([record, pull]) => [
        record,
        pull
          ? (prepared.get(pullKey(pull.taskId, pull.pullId)) ?? pull.publicMessageId ?? null)
          : null,
      ]),
    ) as ReadonlyMap<DurableSemanticRecord, string | null>,
  }),
);

/** Terminal outcome is scoped to the new records, not the whole journal. */
const terminalOutcomeFold: Fold<
  DurableSemanticRecord,
  {
    readonly cancellationClosed: boolean;
    readonly errorClosed: DurableSemanticRecord | undefined;
  }
> = fold(() => {
  let cancellationClosed = false;
  let errorClosed: DurableSemanticRecord | undefined;
  return {
    step(record) {
      if (record.payload.type !== "TaskClosed") return;
      if (record.payload.outcome.status === "cancelled") cancellationClosed = true;
      if (record.payload.outcome.status === "error") errorClosed = record;
    },
    done: () => ({ cancellationClosed, errorClosed }),
  };
});

function* projectRecordsProgram(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
): ProjectionProgram<StreamEvent[], RecordProjectionNote> {
  const index = yield* stage("index-records", function* () {
    const indexed = indexRecordProjection(records, allRecords);
    yield* note({
      kind: "records-indexed",
      records: records.length,
      pullRequests: indexed.pullRequests.size,
      unfinishedTools: indexed.unfinishedToolCalls.length,
    });
    return indexed;
  });

  return yield* stage("project-events", function* () {
    const events = projectRecordsFromIndex(records, allRecords, index);
    yield* note({ kind: "events-projected", events: events.length });
    return events;
  });
}

export function projectRecords(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
): StreamEvent[] {
  const outcome = runProjectionProgram(
    () => projectRecordsProgram(records, allRecords),
    (error) => error,
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function projectRecordsFromIndex(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
  index: RecordProjectionIndex,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const activeToolCalls = new Set<string>();
  for (const recordEntry of records) {
    if (recordEntry.payload.type === "AssistantPartialAccepted") {
      const fact = recordEntry.payload.fact;
      events.push(
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
        events.push(
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
      if (!messageId) continue;
      events.push(
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
      events.push(
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
        ...publicActivityToolStartSnapshots(allRecords, recordEntry, payload),
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
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: payload["callId"] });
      } else if (!startedPreviously) {
        events.push(
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: payload["callId"],
            toolCallName: payload["tool"],
            parentMessageId: `message:${recordEntry.payload.taskId}:${payload["callId"]}`,
          },
          { type: EventType.TOOL_CALL_END, toolCallId: payload["callId"] },
        );
      }
      const failed = payload["failed"] === true;
      const result = payload["result"] ?? null;
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${payload["callId"]}`,
        toolCallId: payload["callId"],
        content: JSON.stringify(
          failed
            ? {
                status: "error",
                errorText:
                  typeof (jsonRecord(result)?.["error"] as Record<string, Json> | undefined)?.[
                    "message"
                  ] === "string"
                    ? (jsonRecord(result)?.["error"] as Record<string, Json>)["message"]
                    : "Tool execution failed",
                detail: result,
              }
            : { status: "ok", output: result },
        ),
        role: "tool",
      });
    }
  }

  if (index.cancellationClosed) {
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
          ...(partial ? { partial } : {}),
        }),
        role: "tool",
      });
    }
  }
  const errored = index.errorClosed;
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
    }
  }
  return events;
}
