import { canonicalSnapshot } from "@sweatpants/foundation";
import {
  InvalidExecutionTransition,
  type DurableReference,
  type DurableRevision,
  type ExecutionId,
  type ExecutionTreeSnapshot,
  type ProgramIdentity,
  type ProjectionFrontier,
  type StoredJson,
  type TaskId,
} from "./contract.ts";

export interface ParkedTaskCheckpoint {
  readonly taskId: TaskId;
  readonly parentTaskId?: TaskId;
  readonly program: ProgramIdentity;
  readonly input: StoredJson;
  readonly route: unknown;
  readonly replayHead: DurableReference | null;
  readonly parkedFrontier: { readonly pullId: string; readonly kind: string };
  readonly actionIndex: number;
}

export interface RecoveryCheckpoint {
  readonly format: "sweatpants.recovery-checkpoint.v1";
  readonly executionId: ExecutionId;
  readonly executionRevision: DurableRevision;
  readonly activationEpoch: number;
  readonly rootTaskId: TaskId;
  readonly tasks: readonly ParkedTaskCheckpoint[];
  readonly pendingInputs: readonly { readonly taskId: TaskId; readonly pullId: string }[];
  readonly requiredOutcomes: readonly {
    readonly parentTaskId: TaskId;
    readonly childTaskId: TaskId;
    readonly pullId: string;
  }[];
  readonly projection: ProjectionFrontier;
}

export type CheckpointRejectionCode =
  | "not_quiescent"
  | "stale_revision"
  | "stale_activation"
  | "host_effect_in_flight";

export type CheckpointDecision =
  | { readonly status: "checkpointed"; readonly checkpoint: RecoveryCheckpoint }
  | { readonly status: "rejected"; readonly code: CheckpointRejectionCode };

export interface CheckpointCommand {
  readonly executionRevision: DurableRevision;
  readonly expectedRevision: DurableRevision;
  readonly activationEpoch: number;
  readonly expectedActivationEpoch: number;
}

/**
 * Verifies durable quiescence and materializes a Recovery Checkpoint.
 *
 * Operational quiescence is the Host's claim; this transition independently
 * proves the durable half: exact revision and activation fence, every task
 * parked on authority-recorded input, nothing runnable, and no Host-owned
 * effect still in flight.
 */
export function proposeQuiescentCut(
  current: ExecutionTreeSnapshot,
  command: CheckpointCommand,
): CheckpointDecision {
  if (command.executionRevision !== command.expectedRevision) {
    return { status: "rejected", code: "stale_revision" };
  }
  if (command.activationEpoch !== command.expectedActivationEpoch) {
    return { status: "rejected", code: "stale_activation" };
  }
  if (current.runnableTaskIds.length > 0) {
    return { status: "rejected", code: "not_quiescent" };
  }

  for (const task of current.tasks) {
    if (task.status !== "parked" || task.pending === null) {
      return { status: "rejected", code: "not_quiescent" };
    }
    if (task.pending.type === "effect" && task.pending.hostOwned) {
      return { status: "rejected", code: "host_effect_in_flight" };
    }
  }

  const parkedTasks = current.tasks.map((task) => ({
    taskId: task.taskId,
    ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
    program: task.program,
    input: task.input,
    route: task.route,
    replayHead: task.replayHead,
    parkedFrontier: { pullId: task.pending!.pullId, kind: task.pending!.type },
    actionIndex: task.actionIndex,
  }));

  const checkpoint: RecoveryCheckpoint = {
    format: "sweatpants.recovery-checkpoint.v1",
    executionId: current.executionId,
    executionRevision: command.executionRevision,
    activationEpoch: command.activationEpoch,
    rootTaskId: current.rootTaskId,
    tasks: parkedTasks,
    pendingInputs: current.tasks
      .filter((task) => task.pending?.type === "elicit")
      .map((task) => ({ taskId: task.taskId, pullId: task.pending!.pullId })),
    requiredOutcomes: current.tasks
      .filter((task) => task.pending?.type === "child")
      .map((task) => ({
        parentTaskId: task.taskId,
        childTaskId: (task.pending as { childTaskId: TaskId }).childTaskId,
        pullId: task.pending!.pullId,
      })),
    projection: current.unpublishedProjection,
  };

  return { status: "checkpointed", checkpoint: canonicalSnapshot(checkpoint).value };
}

/** Boundary parser rejecting a checkpoint missing any required category. */
export function parseRecoveryCheckpoint(value: unknown): RecoveryCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidExecutionTransition("Recovery Checkpoint must be an object");
  }
  const record = value as Record<string, unknown>;
  const required = [
    "format",
    "executionId",
    "executionRevision",
    "activationEpoch",
    "rootTaskId",
    "tasks",
    "pendingInputs",
    "requiredOutcomes",
    "projection",
  ];
  if (Object.keys(record).length !== required.length || !required.every((key) => key in record)) {
    throw new InvalidExecutionTransition("Recovery Checkpoint categories are incomplete");
  }
  if (
    record["format"] !== "sweatpants.recovery-checkpoint.v1" ||
    typeof record["executionId"] !== "string" ||
    !Number.isSafeInteger(record["executionRevision"]) ||
    !Number.isSafeInteger(record["activationEpoch"]) ||
    typeof record["rootTaskId"] !== "string" ||
    !Array.isArray(record["tasks"]) ||
    !Array.isArray(record["pendingInputs"]) ||
    !Array.isArray(record["requiredOutcomes"])
  ) {
    throw new InvalidExecutionTransition("Recovery Checkpoint field value is invalid");
  }
  if (record["tasks"].length === 0) {
    throw new InvalidExecutionTransition("Recovery Checkpoint must retain parked topology");
  }
  // SAFETY: every required category, discriminant, and scalar constraint was
  // validated above before canonical cloning.
  return canonicalSnapshot(record).value as unknown as RecoveryCheckpoint;
}
