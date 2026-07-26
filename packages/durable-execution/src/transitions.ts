import { canonicalSnapshot, sortStrings } from "@sweatpants/foundation";
import type { OperationOutcome } from "@sweatpants/durable-effects/contract";
import {
  InvalidExecutionTransition,
  type ExecutionDecision,
  type ExecutionTreeSnapshot,
  type StoredJson,
  type TaskControlState,
  type TerminalCapsule,
} from "./contract.ts";

export interface CompleteChildCommand {
  readonly childTaskId: string;
  readonly outcome: OperationOutcome;
}

export interface CompleteChildResult {
  readonly parentTaskId: string;
  readonly childTaskId: string;
  readonly parentRunnable: true;
}

/**
 * Atomically folds a structured child into the waiting parent. The returned
 * decision is the only state boundary: no child-terminal/parent-pending shape
 * is representable as an intermediate committed result.
 */
export function completeChild(
  current: ExecutionTreeSnapshot,
  command: CompleteChildCommand,
): ExecutionDecision<CompleteChildResult> {
  const child = task(current, command.childTaskId);
  if (!child.parentTaskId || !child.parentPullId) {
    throw new InvalidExecutionTransition("Only a structurally owned child can be folded");
  }
  const parent = task(current, child.parentTaskId);
  if (
    parent.pending?.type !== "child" ||
    parent.pending.childTaskId !== child.taskId ||
    parent.pending.pullId !== child.parentPullId
  ) {
    throw new InvalidExecutionTransition("Parent is not waiting on this child outcome");
  }

  const parentNext: TaskControlState = {
    ...parent,
    status: "active",
    pending: null,
    pullIndex: parent.pullIndex + 1,
  };
  const tasks = current.tasks
    .filter((candidate) => candidate.taskId !== child.taskId)
    .map((candidate) => (candidate.taskId === parent.taskId ? parentNext : candidate));
  const runnableTaskIds = uniqueSorted([
    ...current.runnableTaskIds.filter((taskId) => taskId !== child.taskId),
    parent.taskId,
  ]);
  const replay = {
    taskId: parent.taskId,
    pullId: child.parentPullId,
    childTaskId: child.taskId,
    outcome: canonicalSnapshot(command.outcome).value,
  };

  return {
    next: { ...current, tasks, runnableTaskIds },
    result: { parentTaskId: parent.taskId, childTaskId: child.taskId, parentRunnable: true },
    privateRecords: [
      {
        type: "child_folded",
        childTaskId: child.taskId,
        parentTaskId: parent.taskId,
        pullId: child.parentPullId,
      },
    ],
    projectionFacts: [],
    replayAppends: [replay],
    payloadWrites: [],
  };
}

export interface CompleteRootCommand {
  readonly outcome: StoredJson;
  readonly disposition: TerminalCapsule["disposition"];
  readonly finalRevision: number;
  readonly completedAt: number;
}

/** Folds a terminal root to bounded authority state without replay/history detail. */
export function completeRoot(
  current: ExecutionTreeSnapshot,
  command: CompleteRootCommand,
): ExecutionDecision<{ readonly publication: "unpublished" }> {
  if (!Number.isSafeInteger(command.finalRevision) || command.finalRevision < 0) {
    throw new InvalidExecutionTransition("Final revision must be a non-negative safe integer");
  }
  if (!Number.isFinite(command.completedAt)) {
    throw new InvalidExecutionTransition("Completion time must be finite");
  }
  if (current.tasks.some((candidate) => candidate.taskId !== current.rootTaskId)) {
    throw new InvalidExecutionTransition("Root cannot terminalize with active structured children");
  }
  task(current, current.rootTaskId);
  const capsule: TerminalCapsule = {
    type: "terminal",
    format: "sweatpants.terminal-execution.v1",
    executionId: current.executionId,
    sessionId: current.sessionId,
    turnId: current.turnId,
    rootTaskId: current.rootTaskId,
    rootProgram: current.rootProgram,
    outcome: canonicalSnapshot(command.outcome).value,
    disposition: command.disposition,
    finalRevision: command.finalRevision,
    completedAt: command.completedAt,
    projection: current.unpublishedProjection,
    publication: "unpublished",
  };
  return {
    next: capsule,
    result: { publication: "unpublished" },
    privateRecords: [],
    projectionFacts: [],
    replayAppends: [],
    payloadWrites: [],
  };
}

/** Strict boundary parser for a persisted Terminal Capsule. */
export function parseTerminalCapsule(value: unknown): TerminalCapsule {
  if (!isRecord(value)) {
    throw new InvalidExecutionTransition("Terminal Capsule must be an object");
  }
  const required = [
    "type",
    "format",
    "executionId",
    "sessionId",
    "turnId",
    "rootTaskId",
    "rootProgram",
    "outcome",
    "disposition",
    "finalRevision",
    "completedAt",
    "projection",
    "publication",
  ];
  if (Object.keys(value).length !== required.length || !required.every((key) => key in value)) {
    throw new InvalidExecutionTransition("Terminal Capsule fields are incomplete or unexpected");
  }
  if (
    value["type"] !== "terminal" ||
    value["format"] !== "sweatpants.terminal-execution.v1" ||
    !nonempty(value["executionId"]) ||
    !nonempty(value["sessionId"]) ||
    !nonempty(value["turnId"]) ||
    !nonempty(value["rootTaskId"]) ||
    !isProgramIdentity(value["rootProgram"]) ||
    !isStoredJson(value["outcome"]) ||
    !["completed", "failed", "cancelled", "superseded"].includes(String(value["disposition"])) ||
    !Number.isSafeInteger(value["finalRevision"]) ||
    (value["finalRevision"] as number) < 0 ||
    typeof value["completedAt"] !== "number" ||
    !Number.isFinite(value["completedAt"]) ||
    !isProjectionFrontier(value["projection"]) ||
    !["unpublished", "published"].includes(String(value["publication"]))
  ) {
    throw new InvalidExecutionTransition("Terminal Capsule field value is invalid");
  }
  // SAFETY: every required field, discriminant, scalar constraint, and closed
  // top-level key was validated above before canonical cloning.
  return canonicalSnapshot(value).value as unknown as TerminalCapsule;
}

function task(snapshot: ExecutionTreeSnapshot, taskId: string): TaskControlState {
  const selected = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (!selected) {
    throw new InvalidExecutionTransition(`Task ${taskId} is not active`);
  }
  return selected;
}

function uniqueSorted(values: readonly string[]): string[] {
  return sortStrings([...new Set(values)]);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isProgramIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    nonempty(value["id"]) &&
    nonempty(value["version"]) &&
    nonempty(value["digest"])
  );
}

function isReference(value: unknown): boolean {
  return isRecord(value) && nonempty(value["id"]);
}

function isStoredJson(value: unknown): boolean {
  return (
    isRecord(value) &&
    ((value["storage"] === "inline" && "value" in value) ||
      (value["storage"] === "reference" && isReference(value["reference"])))
  );
}

function isProjectionFrontier(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value["throughSequence"]) &&
    (value["throughSequence"] as number) >= 0 &&
    (value["facts"] === null || isReference(value["facts"]))
  );
}
