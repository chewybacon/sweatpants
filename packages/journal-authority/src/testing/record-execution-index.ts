import {
  CrankError,
  type PinnedProgram,
  type RecordedOperationDescriptor,
} from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";

import type { TaskOrigin } from "../authority-contract.ts";
import {
  projectExecutionForest,
  type ExecutionForest,
  type ExecutionTask,
  type ProjectedAttempt,
} from "../execution-forest.ts";
import type { DurableSemanticRecord } from "../semantic-record.ts";

export interface RecordExecutionIndex {
  readonly tasks: ReadonlyMap<string, RecordTaskIndex>;
}

export interface RecordTaskIndex {
  readonly taskId: string;
  readonly origin: TaskOrigin;
  readonly artifact: PinnedProgram;
  readonly input: Json;
  readonly actions: readonly RecordActionIndex[];
  readonly lifecycle:
    | { readonly status: "active" }
    | {
        readonly status: "closed";
        readonly outcome: OperationOutcome;
        readonly offset: string;
      };
}

export interface RecordActionIndex {
  readonly actionIndex: number;
  readonly pullIndex: number;
  readonly pullId: string;
  readonly descriptor: RecordedOperationDescriptor;
  readonly attempts: readonly RecordAttemptIndex[];
  readonly settlement?: {
    readonly outcome: OperationOutcome;
    readonly outcomeDigest: string;
    readonly resolutionOffset: string;
  };
}

export interface RecordAttemptIndex {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly status: "started" | "detached" | "abandoned" | "completed" | "indeterminate";
}

type AttemptStatus = RecordAttemptIndex["status"];

interface ValidationAttempt {
  readonly attemptIndex: number;
  status: AttemptStatus;
}

interface ValidationPull {
  readonly taskId: string;
  readonly actionIndex: number;
  readonly pullIndex: number;
  readonly descriptor: RecordedOperationDescriptor;
  readonly attempts: Map<string, ValidationAttempt>;
  settled: boolean;
}

interface ValidationTask {
  readonly pulls: Map<string, ValidationPull>;
  closed: boolean;
}

const allowedPayloads = new Set<DurableSemanticRecord["payload"]["type"]>([
  "TaskOpened",
  "AdvancementBound",
  "AdvancementReleased",
  "PullRequested",
  "AttemptStarted",
  "AttemptDetached",
  "PullIndeterminate",
  "AttemptAbandoned",
  "PullResolved",
  "TaskClosed",
  "AttemptOutcomeUnknown",
]);

function invalid(message: string): never {
  throw new CrankError("invalid_journal", message);
}

function exactTask(tasks: ReadonlyMap<string, ValidationTask>, taskId: string): ValidationTask {
  const task = tasks.get(taskId);
  if (!task) {
    invalid(`Record refers to unopened task ${taskId}`);
  }
  if (task.closed) {
    invalid(`Record refers to closed task ${taskId}`);
  }
  return task;
}

function exactPull(
  pulls: ReadonlyMap<string, ValidationPull>,
  task: ValidationTask,
  taskId: string,
  pullId: string,
): ValidationPull {
  const pull = pulls.get(pullId);
  if (!pull || pull.taskId !== taskId || task.pulls.get(pullId) !== pull) {
    invalid(`Task ${taskId} has no pull ${pullId}`);
  }
  return pull;
}

function exactAttempt(pull: ValidationPull, attemptId: string): ValidationAttempt {
  const attempt = pull.attempts.get(attemptId);
  if (!attempt) {
    invalid(`Pull has no attempt ${attemptId}`);
  }
  return attempt;
}

function validateOffsetAndIdentity(records: readonly DurableSemanticRecord[]): void {
  const eventIds = new Set<string>();
  let previous: bigint | undefined;
  let sessionId: string | undefined;
  for (const record of records) {
    if (!/^(0|[1-9][0-9]*)$/u.test(record.offset)) {
      invalid(`Invalid offset ${record.offset}`);
    }
    const offset = BigInt(record.offset);
    if (previous !== undefined && offset !== previous + 1n) {
      invalid(`Journal offset ${record.offset} is not contiguous`);
    }
    previous = offset;
    sessionId ??= record.sessionId;
    if (record.sessionId !== sessionId) {
      invalid("Record index spans sessions");
    }
    if (eventIds.has(record.eventId)) {
      invalid(`Event ${record.eventId} is not unique`);
    }
    eventIds.add(record.eventId);
    if (record.eventId !== `journal:${record.sessionId}:${record.offset}`) {
      invalid(`Event ${record.eventId} conflicts with its journal identity`);
    }
    if (!allowedPayloads.has(record.payload.type)) {
      invalid(`Unsupported record-only payload ${record.payload.type}`);
    }
  }
}

function validateRecordHistory(records: readonly DurableSemanticRecord[]): void {
  validateOffsetAndIdentity(records);
  const tasks = new Map<string, ValidationTask>();
  const pulls = new Map<string, ValidationPull>();

  for (const record of records) {
    const payload = record.payload;
    if (payload.type === "TaskOpened") {
      if (tasks.has(payload.taskId)) {
        invalid(`Task ${payload.taskId} opened twice`);
      }
      if (payload.parentTaskId !== undefined || payload.parentPullId !== undefined) {
        invalid("The record vertical proof accepts root tasks only");
      }
      if (canonicalSnapshot(payload.input).sha !== payload.inputDigest) {
        invalid(`Task ${payload.taskId} has a conflicting input digest`);
      }
      tasks.set(payload.taskId, { pulls: new Map(), closed: false });
      continue;
    }
    if (payload.type === "AdvancementBound" || payload.type === "AdvancementReleased") {
      continue;
    }
    const task = exactTask(tasks, payload.taskId);
    switch (payload.type) {
      case "PullRequested": {
        if (payload.descriptor.kind !== "record") {
          invalid("Record index received a non-record pull");
        }
        if (pulls.has(payload.pullId)) {
          invalid(`Pull ${payload.pullId} is not unique`);
        }
        if (canonicalSnapshot(payload.descriptor).sha !== payload.descriptorDigest) {
          invalid(`Pull ${payload.pullId} has a conflicting descriptor digest`);
        }
        if (payload.actionIndex !== task.pulls.size || payload.pullIndex !== task.pulls.size) {
          invalid(`Task ${payload.taskId} has conflicting action or pull identity`);
        }
        const pull: ValidationPull = {
          taskId: payload.taskId,
          actionIndex: payload.actionIndex,
          pullIndex: payload.pullIndex,
          descriptor: structuredClone(payload.descriptor),
          attempts: new Map(),
          settled: false,
        };
        task.pulls.set(payload.pullId, pull);
        pulls.set(payload.pullId, pull);
        break;
      }
      case "AttemptStarted": {
        const pull = exactPull(pulls, task, payload.taskId, payload.pullId);
        if (pull.settled) {
          invalid(`Settled pull ${payload.pullId} started an attempt`);
        }
        if (pull.attempts.has(payload.attemptId)) {
          invalid(`Attempt ${payload.attemptId} started twice`);
        }
        if (payload.attemptIndex !== pull.attempts.size) {
          invalid(`Pull ${payload.pullId} has an attempt-index gap`);
        }
        pull.attempts.set(payload.attemptId, {
          attemptIndex: payload.attemptIndex,
          status: "started",
        });
        break;
      }
      case "AttemptDetached": {
        const pull = exactPull(pulls, task, payload.taskId, payload.pullId);
        const attempt = exactAttempt(pull, payload.attemptId);
        if (attempt.status !== "started") {
          invalid(`Attempt ${payload.attemptId} cannot detach`);
        }
        attempt.status = "detached";
        break;
      }
      case "PullIndeterminate": {
        const pull = exactPull(pulls, task, payload.taskId, payload.pullId);
        const attempt = exactAttempt(pull, payload.attemptId);
        if (attempt.status !== "started" && attempt.status !== "detached") {
          invalid(`Attempt ${payload.attemptId} cannot become indeterminate`);
        }
        attempt.status = "indeterminate";
        break;
      }
      case "AttemptOutcomeUnknown": {
        const pull = exactPull(pulls, task, payload.taskId, payload.pullId);
        if (payload.attemptId) {
          const attempt = exactAttempt(pull, payload.attemptId);
          if (attempt.status !== "started" && attempt.status !== "detached") {
            invalid(`Attempt ${payload.attemptId} cannot become outcome-unknown`);
          }
          attempt.status = "indeterminate";
        }
        break;
      }
      case "AttemptAbandoned": {
        const pull = exactPull(pulls, task, payload.taskId, payload.pullId);
        const attempt = exactAttempt(pull, payload.attemptId);
        if (
          attempt.status !== "started" &&
          attempt.status !== "detached" &&
          attempt.status !== "indeterminate"
        ) {
          invalid(`Attempt ${payload.attemptId} cannot be abandoned`);
        }
        attempt.status = "abandoned";
        break;
      }
      case "PullResolved": {
        const pull = exactPull(pulls, task, payload.taskId, payload.pullId);
        if (pull.settled) {
          invalid(`Pull ${payload.pullId} settled twice`);
        }
        if (canonicalSnapshot(payload.outcome).sha !== payload.outcomeDigest) {
          invalid(`Pull ${payload.pullId} has a conflicting outcome digest`);
        }
        if (payload.attemptId) {
          const attempt = exactAttempt(pull, payload.attemptId);
          if (attempt.status !== "started" && attempt.status !== "detached") {
            invalid(`Attempt ${payload.attemptId} cannot complete`);
          }
          attempt.status = "completed";
        }
        pull.settled = true;
        break;
      }
      case "TaskClosed":
        if ([...task.pulls.values()].some((pull) => !pull.settled)) {
          invalid(`Task ${payload.taskId} closed with an open pull`);
        }
        task.closed = true;
        break;
      default:
        invalid(`Unsupported record-only payload ${(payload as { type: string }).type}`);
    }
  }
}

function mapAttempt(attempt: ProjectedAttempt): RecordAttemptIndex {
  if (attempt.status === "superseded") {
    invalid("Record proof does not accept superseded attempts");
  }
  return {
    attemptId: attempt.attemptId,
    attemptIndex: attempt.attemptIndex,
    status: attempt.status,
  };
}

function mapTask(task: ExecutionTask): RecordTaskIndex {
  if (task.origin.kind !== "root") {
    invalid("Record proof index contains a child task");
  }
  if (task.lifecycle.status === "orphaned") {
    invalid("Record proof index contains an orphaned task");
  }
  const actions = task.actions.map((action): RecordActionIndex => {
    if (action.kind !== "pull" || action.descriptor.kind !== "record") {
      invalid("Record proof index contains a non-record action");
    }
    if (action.children.length > 0) {
      invalid("Record proof index contains child actions");
    }
    return {
      actionIndex: action.actionIndex,
      pullIndex: action.pullIndex,
      pullId: action.pullId,
      descriptor: structuredClone(action.descriptor),
      attempts: action.attempts.map(mapAttempt),
      ...(action.settlement
        ? {
            settlement: {
              outcome: structuredClone(action.settlement.outcome),
              outcomeDigest: action.settlement.outcomeDigest,
              resolutionOffset: action.settlement.offset,
            },
          }
        : {}),
    };
  });
  return {
    taskId: task.taskId,
    origin: structuredClone(task.origin),
    artifact: structuredClone(task.artifact),
    input: structuredClone(task.input),
    actions,
    lifecycle: structuredClone(task.lifecycle),
  };
}

/** Strictly folds the accepted root-record vocabulary into a semantic index. */
export function foldRecordExecutionIndex(
  records: readonly DurableSemanticRecord[],
): RecordExecutionIndex {
  validateRecordHistory(records);
  const forest = projectExecutionForest(records);
  const tasks = new Map<string, RecordTaskIndex>();
  for (const root of forest.roots) {
    tasks.set(root.taskId, mapTask(root));
  }
  return { tasks };
}

function normalizedIndex(index: RecordExecutionIndex): Json {
  return assertJson([...index.tasks.values()].map((task) => structuredClone(task)));
}

function normalizedForest(forest: ExecutionForest): Json {
  return assertJson(forest.roots.map(mapTask));
}

/** Fails when the strict record fold differs from the existing journal projection. */
export function assertRecordExecutionIndexMatchesForest(
  index: RecordExecutionIndex,
  forest: ExecutionForest,
): void {
  if (
    canonicalSnapshot(normalizedIndex(index)).sha !==
    canonicalSnapshot(normalizedForest(forest)).sha
  ) {
    invalid("Record execution index differs from the execution forest");
  }
}
