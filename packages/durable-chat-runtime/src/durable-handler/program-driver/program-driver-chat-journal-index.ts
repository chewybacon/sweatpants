import { CrankError } from "@sweatpants/durable-execution";
import type { DurableSemanticRecord } from "@sweatpants/journal-authority";
import { combine, fold, mapFold, runFold, type Fold, type Json } from "@sweatpants/foundation";
import { jsonRecord } from "./program-driver-chat-projection-codecs.ts";

export type PullRequestedRecord = Extract<
  DurableSemanticRecord["payload"],
  { type: "PullRequested" }
>;
export type PendingElicit = Omit<PullRequestedRecord, "descriptor"> & {
  descriptor: Extract<PullRequestedRecord["descriptor"], { kind: "elicit" }>;
};
export type TaskOpenedRecord = Extract<DurableSemanticRecord["payload"], { type: "TaskOpened" }>;
export type ToolStartFact = {
  readonly callId: string;
  readonly tool: string;
  readonly payload: Record<string, Json>;
};

export interface ChatJournalIndex {
  readonly pullRequests: ReadonlyMap<string, PullRequestedRecord>;
  readonly resolvedPullIds: ReadonlySet<string>;
  readonly tasks: ReadonlyMap<string, TaskOpenedRecord>;
  readonly toolStartBeforePull: ReadonlyMap<string, ToolStartFact>;
  readonly publicToolCallIds: ReadonlySet<string>;
  readonly previousToolStarts: ReadonlyMap<string, Record<string, Json>>;
  readonly toolMessageIds: ReadonlyMap<string, string>;
  readonly unfinishedToolCalls: readonly { callId: string; tool: string }[];
  readonly cancellationPartials: ReadonlyMap<string, Json>;
  readonly modelMessageIds: ReadonlyMap<DurableSemanticRecord, string | null>;
}

/** Builds every durable-chat projection relation in one journal traversal. */
export function indexChatJournal(records: readonly DurableSemanticRecord[]): ChatJournalIndex {
  return runFold(chatJournalIndexFold, records);
}

export function pendingElicit(index: ChatJournalIndex, pullId: string): PendingElicit | undefined {
  if (index.resolvedPullIds.has(pullId)) return undefined;
  const request = index.pullRequests.get(pullId);
  if (request?.descriptor.kind !== "elicit") return undefined;
  return { ...request, descriptor: request.descriptor };
}

export function parentToolStart(
  index: ChatJournalIndex,
  taskId: string,
): ToolStartFact | undefined {
  const task = index.tasks.get(taskId);
  if (!task?.parentPullId) return undefined;
  const parentPull = index.pullRequests.get(task.parentPullId);
  if (!parentPull) {
    throw new CrankError("invalid_journal", `Task ${taskId} refers to an absent parent pull`);
  }
  if (task.parentTaskId !== parentPull.taskId) {
    throw new CrankError("invalid_journal", `Task ${taskId} disagrees with its parent pull`);
  }
  return index.toolStartBeforePull.get(task.parentPullId);
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

const projectionRelationsFold: Fold<
  DurableSemanticRecord,
  {
    readonly resolvedPullIds: ReadonlySet<string>;
    readonly tasks: ReadonlyMap<string, TaskOpenedRecord>;
    readonly toolStartBeforePull: ReadonlyMap<string, ToolStartFact>;
    readonly publicToolCallIds: ReadonlySet<string>;
  }
> = fold(() => {
  const resolvedPullIds = new Set<string>();
  const tasks = new Map<string, TaskOpenedRecord>();
  const latestToolStartByTask = new Map<string, ToolStartFact>();
  const toolStartBeforePull = new Map<string, ToolStartFact>();
  const publicToolCallIds = new Set<string>();
  return {
    step(record) {
      const payload = record.payload;
      if (payload.type === "TaskOpened" && !tasks.has(payload.taskId)) {
        tasks.set(payload.taskId, payload);
        return;
      }
      if (payload.type === "PullResolved") {
        resolvedPullIds.add(payload.pullId);
        return;
      }
      if (payload.type === "PullRequested") {
        const preceding = latestToolStartByTask.get(payload.taskId);
        if (preceding) toolStartBeforePull.set(payload.pullId, preceding);
        return;
      }
      if (payload.type !== "DurableEmission" || payload.descriptor.eventType !== "tool_started") {
        return;
      }
      const value = jsonRecord(payload.descriptor.payload);
      if (typeof value?.["callId"] !== "string" || typeof value["tool"] !== "string") return;
      const fact = { callId: value["callId"], tool: value["tool"], payload: value };
      latestToolStartByTask.set(payload.taskId, fact);
      publicToolCallIds.add(fact.callId);
    },
    done: () => ({ resolvedPullIds, tasks, toolStartBeforePull, publicToolCallIds }),
  };
});

/** Started/completed pairing resolves in `done()`, not in a second pass. */
const toolLifecycleFold: Fold<
  DurableSemanticRecord,
  {
    readonly previousToolStarts: ReadonlyMap<string, Record<string, Json>>;
    readonly toolMessageIds: ReadonlyMap<string, string>;
    readonly unfinishedToolCalls: readonly { callId: string; tool: string }[];
  }
> = fold(() => {
  const started = new Map<string, string>();
  const completed = new Set<string>();
  const previousToolStarts = new Map<string, Record<string, Json>>();
  const toolMessageIds = new Map<string, string>();
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
        toolMessageIds.set(
          payload["callId"],
          `message:${record.payload.taskId}:${payload["callId"]}`,
        );
      }
      if (record.payload.descriptor.eventType === "tool_completed") {
        completed.add(payload["callId"]);
      }
    },
    done: () => ({
      previousToolStarts,
      toolMessageIds,
      unfinishedToolCalls: [...started]
        .filter(([callId]) => !completed.has(callId))
        .map(([callId, tool]) => ({ callId, tool })),
    }),
  };
});

const cancellationLinksFold: Fold<
  DurableSemanticRecord,
  readonly { readonly pullId: string; readonly partial: Json }[]
> = fold(() => {
  const links: { readonly pullId: string; readonly partial: Json }[] = [];
  return {
    step(record) {
      const payload = record.payload;
      if (payload.type !== "PullResolved" || payload.outcome.status !== "cancelled") return;
      if (payload.outcome.partial !== undefined) {
        links.push({ pullId: payload.pullId, partial: payload.outcome.partial });
      }
    },
    done: () => links,
  };
});

/** Injective, allocation-cheap composite key. Ids are opaque, so length-prefix. */
function pullKey(taskId: string, pullId: string): string {
  return `${taskId.length}:${taskId}:${pullId}`;
}

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
      if (payload.type === "DurableEmission") {
        links.set(record, lastModelPullByTask.get(payload.taskId) ?? null);
      }
    },
    done: () => links,
  };
});

const chatJournalIndexFold = mapFold(
  combine({
    pullRequests: pullRequestsFold,
    relations: projectionRelationsFold,
    toolLifecycle: toolLifecycleFold,
    cancellationLinks: cancellationLinksFold,
    prepared: preparedFold,
    modelLinks: modelLinksFold,
  }),
  ({ pullRequests, relations, toolLifecycle, cancellationLinks, prepared, modelLinks }) => ({
    pullRequests,
    ...relations,
    previousToolStarts: toolLifecycle.previousToolStarts,
    toolMessageIds: toolLifecycle.toolMessageIds,
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
