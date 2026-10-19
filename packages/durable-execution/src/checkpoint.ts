import { durableReferenceSchema } from "./reference-schema.ts";
import { parser, type Parser } from "@sweatpants/foundation";
import { z } from "zod";
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

const checkpointTextSchema = z.string().min(1).max(4_096);
const checkpointStoredJsonSchema = z.discriminatedUnion("storage", [
  z.strictObject({ storage: z.literal("inline"), value: z.json() }),
  z.strictObject({ storage: z.literal("reference"), reference: durableReferenceSchema }),
]);
const checkpointProgramSchema = z.strictObject({
  id: checkpointTextSchema,
  version: checkpointTextSchema,
  digest: checkpointTextSchema,
});
const parkedTaskCheckpointSchema = z.strictObject({
  taskId: checkpointTextSchema,
  parentTaskId: checkpointTextSchema.optional(),
  program: checkpointProgramSchema,
  input: checkpointStoredJsonSchema,
  route: z.json(),
  replayHead: z.union([durableReferenceSchema, z.null()]),
  parkedFrontier: z.strictObject({ pullId: checkpointTextSchema, kind: checkpointTextSchema }),
  actionIndex: z.number().int().nonnegative().safe(),
});
const recoveryCheckpointSchema = z.strictObject({
  format: z.literal("sweatpants.recovery-checkpoint.v1"),
  executionId: checkpointTextSchema,
  executionRevision: z.number().int().nonnegative().safe(),
  activationEpoch: z.number().int().nonnegative().safe(),
  rootTaskId: checkpointTextSchema,
  tasks: z.array(parkedTaskCheckpointSchema).min(1).max(16_384),
  pendingInputs: z
    .array(z.strictObject({ taskId: checkpointTextSchema, pullId: checkpointTextSchema }))
    .max(16_384),
  requiredOutcomes: z
    .array(
      z.strictObject({
        parentTaskId: checkpointTextSchema,
        childTaskId: checkpointTextSchema,
        pullId: checkpointTextSchema,
      }),
    )
    .max(16_384),
  projection: z.strictObject({
    throughSequence: z.number().int().nonnegative().safe(),
    facts: z.union([durableReferenceSchema, z.null()]),
  }),
});

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
    parentTaskId: task.parentTaskId,
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

  return { status: "checkpointed", checkpoint: structuredClone(checkpoint) };
}

/** Result-oriented parser for malformed or incomplete persisted checkpoints. */
export const recoveryCheckpointParser: Parser<RecoveryCheckpoint> =
  parser(recoveryCheckpointSchema);

/** Caller-owned throwing mapping for the checkpoint restoration boundary. */
export function parseRecoveryCheckpoint(value: unknown): RecoveryCheckpoint {
  const parsed = recoveryCheckpointParser.parse(value);
  if (!parsed.ok) {
    const taskIssue = parsed.issues.find((issue) => issue.path[0] === "tasks");
    if (taskIssue?.code === "too_small") {
      throw new InvalidExecutionTransition("Recovery Checkpoint must retain parked topology");
    }
    if (taskIssue?.code === "invalid_type") {
      throw new InvalidExecutionTransition("Recovery Checkpoint categories are incomplete");
    }
    throw new InvalidExecutionTransition("Recovery Checkpoint field value is invalid");
  }
  return parsed.value;
}
