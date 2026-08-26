import {
  CrankError,
  type DurableOperationDescriptor,
  type PinnedProgram,
} from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { Json } from "@sweatpants/foundation";

import type { DurableSemanticRecord } from "./semantic-record.ts";
import type { TaskOrigin } from "./authority-contract.ts";

export interface ProjectedAttempt {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly status:
    | "started"
    | "detached"
    | "abandoned"
    | "superseded"
    | "completed"
    | "indeterminate";
  readonly winnerAttemptId?: string;
}

export interface ProjectedSettlement {
  readonly outcome: OperationOutcome;
  readonly outcomeDigest: string;
  readonly offset: string;
}

export type ProjectedTaskLifecycle =
  | { readonly status: "active" }
  | { readonly status: "closed"; readonly outcome: OperationOutcome; readonly offset: string }
  | { readonly status: "orphaned"; readonly reason: string; readonly offset: string };

export type ExecutionAction =
  | {
      readonly kind: "emission";
      readonly actionIndex: number;
      readonly emissionIndex: number;
      readonly descriptor: { readonly eventType: string; readonly payload: Json };
    }
  | {
      readonly kind: "pull";
      readonly actionIndex: number;
      readonly pullIndex: number;
      readonly pullId: string;
      readonly descriptor: DurableOperationDescriptor;
      readonly attempts: readonly ProjectedAttempt[];
      readonly settlement?: ProjectedSettlement;
      readonly children: readonly ExecutionTask[];
    };

export interface ExecutionTask {
  readonly taskId: string;
  readonly origin: TaskOrigin;
  readonly artifact: PinnedProgram;
  readonly input: Json;
  readonly lifecycle: ProjectedTaskLifecycle;
  readonly actions: readonly ExecutionAction[];
}

export interface ExecutionForest {
  readonly roots: readonly ExecutionTask[];
}

interface MutableAttempt {
  attemptId: string;
  attemptIndex: number;
  status: ProjectedAttempt["status"];
  winnerAttemptId?: string;
}

interface MutablePull {
  kind: "pull";
  actionIndex: number;
  pullIndex: number;
  pullId: string;
  descriptor: DurableOperationDescriptor;
  attempts: MutableAttempt[];
  settlement?: ProjectedSettlement;
  childIds: string[];
}

interface MutableEmission {
  kind: "emission";
  actionIndex: number;
  emissionIndex: number;
  descriptor: { eventType: string; payload: Json };
}

type MutableAction = MutablePull | MutableEmission;

interface MutableTask {
  taskId: string;
  origin: TaskOrigin;
  artifact: PinnedProgram;
  input: Json;
  lifecycle: ProjectedTaskLifecycle;
  actions: Map<number, MutableAction>;
}

/** Builds the one deployment-neutral, non-authoritative execution projection. */
export function projectExecutionForest(records: readonly DurableSemanticRecord[]): ExecutionForest {
  const tasks = new Map<string, MutableTask>();
  const pulls = new Map<string, { task: MutableTask; pull: MutablePull }>();

  for (const record of records) {
    const payload = record.payload;
    if (payload.type === "TaskOpened") {
      if (tasks.has(payload.taskId)) invalid(`Task ${payload.taskId} opened more than once`);
      if ((payload.parentTaskId === undefined) !== (payload.parentPullId === undefined)) {
        invalid(`Task ${payload.taskId} has a partial parent origin`);
      }
      const origin: TaskOrigin = payload.parentTaskId
        ? {
            kind: "child",
            invokedBy: { taskId: payload.parentTaskId, pullId: payload.parentPullId! },
          }
        : { kind: "root" };
      tasks.set(payload.taskId, {
        taskId: payload.taskId,
        origin,
        artifact: {
          id: payload.programId,
          version: payload.programVersion,
          digest: payload.programDigest,
        },
        input: structuredClone(payload.input),
        lifecycle: { status: "active" },
        actions: new Map(),
      });
      continue;
    }

    const task = tasks.get(payload.taskId);
    if (!task) invalid(`Record ${record.eventId} refers to unopened task ${payload.taskId}`);

    switch (payload.type) {
      case "PullRequested": {
        if (task.actions.has(payload.actionIndex)) {
          invalid(`Task ${task.taskId} repeats action ${payload.actionIndex}`);
        }
        if (pulls.has(payload.pullId)) invalid(`Pull ${payload.pullId} is not unique`);
        const pull: MutablePull = {
          kind: "pull",
          actionIndex: payload.actionIndex,
          pullIndex: payload.pullIndex,
          pullId: payload.pullId,
          descriptor: structuredClone(payload.descriptor),
          attempts: [],
          childIds: [],
        };
        task.actions.set(payload.actionIndex, pull);
        pulls.set(payload.pullId, { task, pull });
        break;
      }
      case "DurableEmission": {
        if (task.actions.has(payload.actionIndex)) {
          invalid(`Task ${task.taskId} repeats action ${payload.actionIndex}`);
        }
        task.actions.set(payload.actionIndex, {
          kind: "emission",
          actionIndex: payload.actionIndex,
          emissionIndex: payload.emissionIndex,
          descriptor: structuredClone(payload.descriptor),
        });
        break;
      }
      case "AttemptStarted": {
        const pull = exactPull(pulls, task, payload.pullId);
        if (pull.attempts.some((attempt) => attempt.attemptId === payload.attemptId)) {
          invalid(`Attempt ${payload.attemptId} started more than once`);
        }
        pull.attempts.push({
          attemptId: payload.attemptId,
          attemptIndex: payload.attemptIndex,
          status: "started",
        });
        break;
      }
      case "AttemptDetached":
        updateAttempt(pulls, task, payload.pullId, payload.attemptId, "detached");
        break;
      case "AttemptAbandoned":
        updateAttempt(pulls, task, payload.pullId, payload.attemptId, "abandoned");
        break;
      case "AttemptSuperseded": {
        const attempt = updateAttempt(pulls, task, payload.pullId, payload.attemptId, "superseded");
        attempt.winnerAttemptId = payload.winnerAttemptId;
        break;
      }
      case "PullIndeterminate":
      case "AttemptOutcomeUnknown":
        if (payload.attemptId) {
          updateAttempt(pulls, task, payload.pullId, payload.attemptId, "indeterminate");
        }
        break;
      case "PullResolved": {
        const pull = exactPull(pulls, task, payload.pullId);
        if (pull.settlement) invalid(`Pull ${payload.pullId} settled more than once`);
        if (payload.attemptId) {
          updateAttempt(pulls, task, payload.pullId, payload.attemptId, "completed");
        }
        pull.settlement = {
          outcome: structuredClone(payload.outcome),
          outcomeDigest: payload.outcomeDigest,
          offset: record.offset,
        };
        break;
      }
      case "TaskClosed":
        if (task.lifecycle.status !== "active") invalid(`Task ${task.taskId} closed twice`);
        task.lifecycle = {
          status: "closed",
          outcome: structuredClone(payload.outcome),
          offset: record.offset,
        };
        break;
      case "TaskOrphaned":
        if (task.lifecycle.status !== "active")
          invalid(`Task ${task.taskId} became terminal twice`);
        task.lifecycle = { status: "orphaned", reason: payload.reason, offset: record.offset };
        break;
      case "ModelContextPrepared":
      case "AssistantPartialAccepted":
      case "RaceWinnerSelected":
      case "CancellationRequested":
      case "CancellationPartialDiscarded":
      case "CleanupSkipped":
      case "ForkGroupOpened":
      case "ForkGroupBreached":
      case "ForkGroupResolved":
      case "ForkGroupOrphaned":
        break;
      default:
        assertNever(payload);
    }
  }

  for (const task of tasks.values()) {
    if (task.origin.kind === "root") continue;
    const parent = tasks.get(task.origin.invokedBy.taskId);
    if (!parent) invalid(`Task ${task.taskId} has no parent task`);
    const located = pulls.get(task.origin.invokedBy.pullId);
    if (!located || located.task !== parent) invalid(`Task ${task.taskId} has no parent pull`);
    if (!isChildDescriptor(located.pull.descriptor)) {
      invalid(`Task ${task.taskId} parent pull is not a child operation`);
    }
    if (located.pull.childIds.includes(task.taskId)) invalid(`Task ${task.taskId} has two parents`);
    located.pull.childIds.push(task.taskId);
  }

  validateIndexes(tasks);
  detectCycles(tasks);
  const roots = [...tasks.values()].filter((task) => task.origin.kind === "root");
  const projected = roots.map((task) => projectTask(task, tasks, new Set()));
  const reachable = new Set<string>();
  visitProjected(projected, reachable);
  if (reachable.size !== tasks.size) invalid("Execution topology contains an unreachable task");
  return { roots: projected };
}

function validateIndexes(tasks: ReadonlyMap<string, MutableTask>): void {
  for (const task of tasks.values()) {
    const actions = [...task.actions.values()].sort(
      (left, right) => left.actionIndex - right.actionIndex,
    );
    let pullIndex = 0;
    let emissionIndex = 0;
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex]!;
      if (action.actionIndex !== actionIndex) invalid(`Task ${task.taskId} has an action gap`);
      if (action.kind === "pull") {
        if (action.pullIndex !== pullIndex) invalid(`Task ${task.taskId} has a pull-index gap`);
        pullIndex += 1;
      } else {
        if (action.emissionIndex !== emissionIndex)
          invalid(`Task ${task.taskId} has an emission-index gap`);
        emissionIndex += 1;
      }
    }
  }
}

function detectCycles(tasks: ReadonlyMap<string, MutableTask>): void {
  for (const task of tasks.values()) {
    const seen = new Set<string>();
    let cursor: MutableTask | undefined = task;
    while (cursor?.origin.kind === "child") {
      if (seen.has(cursor.taskId)) invalid("Execution topology contains a cycle");
      seen.add(cursor.taskId);
      cursor = tasks.get(cursor.origin.invokedBy.taskId);
    }
  }
}

function projectTask(
  task: MutableTask,
  tasks: ReadonlyMap<string, MutableTask>,
  ancestors: ReadonlySet<string>,
): ExecutionTask {
  if (ancestors.has(task.taskId)) invalid("Execution topology contains a cycle");
  const nextAncestors = new Set(ancestors).add(task.taskId);
  const actions = [...task.actions.values()]
    .sort((left, right) => left.actionIndex - right.actionIndex)
    .map((action): ExecutionAction => {
      if (action.kind === "emission") {
        return {
          kind: "emission",
          actionIndex: action.actionIndex,
          emissionIndex: action.emissionIndex,
          descriptor: structuredClone(action.descriptor),
        };
      }
      return {
        kind: "pull",
        actionIndex: action.actionIndex,
        pullIndex: action.pullIndex,
        pullId: action.pullId,
        descriptor: structuredClone(action.descriptor),
        attempts: action.attempts.map((attempt) => ({ ...attempt })),
        ...(action.settlement ? { settlement: structuredClone(action.settlement) } : {}),
        children: action.childIds.map((childId) => {
          const child = tasks.get(childId);
          if (!child) invalid(`Missing child ${childId}`);
          return projectTask(child, tasks, nextAncestors);
        }),
      };
    });
  return {
    taskId: task.taskId,
    origin: structuredClone(task.origin),
    artifact: structuredClone(task.artifact),
    input: structuredClone(task.input),
    lifecycle: structuredClone(task.lifecycle),
    actions,
  };
}

function exactPull(
  pulls: ReadonlyMap<string, { task: MutableTask; pull: MutablePull }>,
  task: MutableTask,
  pullId: string,
): MutablePull {
  const located = pulls.get(pullId);
  if (!located || located.task !== task) invalid(`Task ${task.taskId} has no pull ${pullId}`);
  return located.pull;
}

function updateAttempt(
  pulls: ReadonlyMap<string, { task: MutableTask; pull: MutablePull }>,
  task: MutableTask,
  pullId: string,
  attemptId: string,
  status: MutableAttempt["status"],
): MutableAttempt {
  const pull = exactPull(pulls, task, pullId);
  const attempt = pull.attempts.find((candidate) => candidate.attemptId === attemptId);
  if (!attempt) invalid(`Pull ${pullId} has no attempt ${attemptId}`);
  attempt.status = status;
  return attempt;
}

function isChildDescriptor(descriptor: DurableOperationDescriptor): boolean {
  return ["invoke", "all", "race", "spawn", "join"].includes(descriptor.kind);
}

function visitProjected(tasks: readonly ExecutionTask[], visited: Set<string>): void {
  for (const task of tasks) {
    if (visited.has(task.taskId)) invalid(`Task ${task.taskId} is projected twice`);
    visited.add(task.taskId);
    for (const action of task.actions) {
      if (action.kind === "pull") visitProjected(action.children, visited);
    }
  }
}

function invalid(message: string): never {
  throw new CrankError("invalid_journal", message);
}

function assertNever(value: never): never {
  return invalid(`Unknown semantic payload ${(value as { type?: unknown }).type as string}`);
}
