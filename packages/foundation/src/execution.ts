import { createExecutionDiscipline } from "./execution-discipline.ts";
import type { IterableOperation as Operation } from "./computation.ts";
import { composeOperation, type OperationMiddleware, type OperationOptions } from "./operation.ts";

/** One occurrence of a suspension, scoped to a live execution handle. */
export type SuspensionId = string;

/** Requests may describe one operation or a structured group of children. */
export type ExecutionBoundary<Request, Output, Failure = unknown> =
  | { readonly kind: "suspended"; readonly suspensionId: SuspensionId; readonly request: Request }
  | { readonly kind: "completed"; readonly value: Output }
  | { readonly kind: "failed"; readonly error: Failure }
  | { readonly kind: "cancelled"; readonly reason?: string };

/**
 * Live computation capability, never a serializable wire handle.
 * Commands must be serialized. A resume addresses the current suspension only.
 * Cancellation may suspend for cleanup; disposal only releases compute.
 * Transport failure throws: it must not be confused with a program failure.
 * Recovery, authorization, journal receipts and inspection are separate contracts.
 */
export interface Execution<Request, Reply, Output, Failure = unknown, Y = never> {
  resume(
    suspensionId: SuspensionId,
    reply: Reply,
  ): Operation<ExecutionBoundary<Request, Output, Failure>, Y>;
  cancel(reason?: string): Operation<ExecutionBoundary<Request, Output, Failure>, Y>;
  dispose(): Operation<void, Y>;
}

/**
 * Return-value pair: a live handle and the boundary it reached.
 * This pair has no separate lifecycle. Activation names the host episode.
 * The boundary is a value at this return point, not a live-updating snapshot.
 */
export interface ExecutionState<E, B> {
  readonly execution: E;
  readonly boundary: B;
}

export interface Checkpointing<Snapshot, Y = never> {
  /** Read-only capture; must not advance or mutate the guest. */
  capture(): Operation<Snapshot, Y>;
}

export interface CheckpointExecution<Request, Reply, Output, Failure, Snapshot, Y>
  extends Execution<Request, Reply, Output, Failure, Y>, Checkpointing<Snapshot, Y> {}

export interface ExecutionOptions<Request, Reply, Output, Failure, Y> extends OperationOptions<
  Execution<Request, Reply, Output, Failure, Y>
> {
  initial: ExecutionBoundary<Request, Output, Failure>;
  /** Synchronous validation before advancement begins. */
  validateReply?(request: Request, reply: Reply): void;
}

export interface CheckpointExecutionOptions<
  Request,
  Reply,
  Output,
  Failure,
  Snapshot,
  Y,
> extends ExecutionOptions<Request, Reply, Output, Failure, Y> {
  driver: CheckpointExecution<Request, Reply, Output, Failure, Snapshot, Y>;
  middleware?: readonly OperationMiddleware<
    CheckpointExecution<Request, Reply, Output, Failure, Snapshot, Y>
  >[];
}

export interface Executor<Program, Input, Request, Reply, Output, Failure = unknown, Y = never> {
  start(
    program: Program,
    input: Input,
  ): Operation<
    ExecutionState<
      Execution<Request, Reply, Output, Failure, Y>,
      ExecutionBoundary<Request, Output, Failure>
    >,
    Y
  >;
}

/** Commands address one live operative; routing and durable command IDs are adapter-owned. */
export type ExecutionCommand<Reply> =
  | { readonly kind: "resume"; readonly suspensionId: SuspensionId; readonly reply: Reply }
  | { readonly kind: "cancel"; readonly reason?: string };

/** Transport/evaluator mechanics behind the shared execution state machine. */
export interface ExecutionDriver<Request, Reply, Output, Failure, Y> {
  turn(command: ExecutionCommand<Reply>): Operation<ExecutionBoundary<Request, Output, Failure>, Y>;
  /** Release must tolerate retry after failure/interruption, including partial release. */
  dispose(): Operation<void, Y>;
  /** Synchronous domain validation before a command can reach the operative. */
  validateReply?(request: Request, reply: Reply): void;
}

/** The same per-execution discipline is used with or without checkpointing. */
function createDiscipline<Request, Reply, Output, Failure, Y>(
  options: ExecutionOptions<Request, Reply, Output, Failure, Y>,
) {
  const discipline = createExecutionDiscipline<ExecutionBoundary<Request, Output, Failure>, Y>(
    options.initial,
  );
  const execution: Execution<Request, Reply, Output, Failure, Y> = {
    *resume(suspensionId, reply) {
      const boundary = discipline.current();
      if (boundary.kind !== "suspended" || boundary.suspensionId !== suspensionId) {
        throw new Error("execution_suspension_mismatch");
      }
      options.validateReply?.(boundary.request, reply);
      return yield* discipline.advance(() => options.driver.resume(suspensionId, reply));
    },
    *cancel(reason) {
      const boundary = discipline.current();
      if (boundary.kind !== "suspended") {
        return boundary;
      }
      return yield* discipline.advance(() => options.driver.cancel(reason));
    },
    dispose: () => discipline.dispose(() => options.driver.dispose()),
  };
  return { execution, capture: discipline.capture };
}

function composeExecution<Request, Reply, Output, Failure, Y>(
  execution: Execution<Request, Reply, Output, Failure, Y>,
  middleware: readonly OperationMiddleware<Execution<Request, Reply, Output, Failure, Y>>[],
): Execution<Request, Reply, Output, Failure, Y> {
  return {
    resume: composeOperation(
      (id, reply) => execution.resume(id, reply),
      middleware.map((m) => m.resume),
    ),
    cancel: composeOperation(
      (reason) => execution.cancel(reason),
      middleware.map((m) => m.cancel),
    ),
    dispose: composeOperation(
      () => execution.dispose(),
      middleware.map((m) => m.dispose),
    ),
  };
}

/** Replay executions have no capture capability. Discipline cannot be uninstalled. */
export function createExecution<Request, Reply, Output, Failure = unknown, Y = never>(
  options: ExecutionOptions<Request, Reply, Output, Failure, Y>,
): ExecutionState<
  Execution<Request, Reply, Output, Failure, Y>,
  ExecutionBoundary<Request, Output, Failure>
> {
  const discipline = createDiscipline(options);
  return {
    boundary: options.initial,
    execution: composeExecution(discipline.execution, options.middleware ?? []),
  };
}

/** Capture shares the same guard as advancement and disposal on this execution. */
export function createCheckpointExecution<Request, Reply, Output, Failure, Snapshot, Y>(
  options: CheckpointExecutionOptions<Request, Reply, Output, Failure, Snapshot, Y>,
): ExecutionState<
  CheckpointExecution<Request, Reply, Output, Failure, Snapshot, Y>,
  ExecutionBoundary<Request, Output, Failure>
> {
  const discipline = createDiscipline(options);
  const middleware = options.middleware ?? [];
  return {
    boundary: options.initial,
    execution: {
      ...composeExecution(discipline.execution, middleware),
      capture: composeOperation(
        () => discipline.capture(() => options.driver.capture()),
        middleware.map((m) => m.capture),
      ),
    },
  };
}
