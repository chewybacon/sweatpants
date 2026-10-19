import { durableReferenceSchema } from "./reference-schema.ts";
import { sortStrings, cloneJson } from "@sweatpants/foundation";
import { parser } from "@sweatpants/foundation/parser";
import { z } from "zod";
import type { OperationOutcome } from "@sweatpants/durable-effects/contract";
import {
  InvalidExecutionTransition,
  type ExecutionDecision,
  type ExecutionTreeSnapshot,
  type StoredJson,
  type TaskControlState,
  type TerminalCapsule,
} from "./contract.ts";

const nonemptySchema = z.string().min(1).max(4_096);
const storedJsonSchema = z.discriminatedUnion("storage", [
  z.strictObject({ storage: z.literal("inline"), value: z.json() }),
  z.strictObject({ storage: z.literal("reference"), reference: durableReferenceSchema }),
]);
const programIdentitySchema = z.strictObject({
  id: nonemptySchema,
  version: nonemptySchema,
  digest: nonemptySchema,
});
const projectionFrontierSchema = z.strictObject({
  throughSequence: z.number().int().nonnegative().safe(),
  facts: z.union([durableReferenceSchema, z.null()]),
});
const terminalCapsuleSchema = z.strictObject({
  type: z.literal("terminal"),
  format: z.literal("sweatpants.terminal-execution.v1"),
  executionId: nonemptySchema,
  sessionId: nonemptySchema,
  turnId: nonemptySchema,
  rootTaskId: nonemptySchema,
  rootProgram: programIdentitySchema,
  outcome: storedJsonSchema,
  disposition: z.enum(["completed", "failed", "cancelled", "superseded"]),
  finalRevision: z.number().int().nonnegative().safe(),
  completedAt: z.number().finite(),
  projection: projectionFrontierSchema,
  publication: z.enum(["unpublished", "published"]),
});

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
    outcome: cloneJson(command.outcome),
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
    outcome: cloneJson(command.outcome),
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

/** Strict result-oriented parser for a persisted Terminal Capsule. */
export const terminalCapsuleParser = parser(terminalCapsuleSchema).map(
  (value): TerminalCapsule => cloneJson(value),
);

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
