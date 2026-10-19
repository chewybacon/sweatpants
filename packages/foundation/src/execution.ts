import type { Operation } from "effection";
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
export interface Execution<Request, Reply, Output, Failure = unknown> {
  resume(
    suspensionId: SuspensionId,
    reply: Reply,
  ): Operation<ExecutionBoundary<Request, Output, Failure>>;
  cancel(reason?: string): Operation<ExecutionBoundary<Request, Output, Failure>>;
  dispose(): Operation<void>;
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

export interface Checkpointing<Snapshot> {
  /** Read-only capture; must not advance or mutate the guest. */
  capture(): Operation<Snapshot>;
}

export interface CheckpointExecution<Request, Reply, Output, Failure, Snapshot>
  extends Execution<Request, Reply, Output, Failure>, Checkpointing<Snapshot> {}

export interface ExecutionOptions<Request, Reply, Output, Failure> extends OperationOptions<
  Execution<Request, Reply, Output, Failure>
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
> extends ExecutionOptions<Request, Reply, Output, Failure> {
  driver: CheckpointExecution<Request, Reply, Output, Failure, Snapshot>;
  middleware?: readonly OperationMiddleware<
    CheckpointExecution<Request, Reply, Output, Failure, Snapshot>
  >[];
}

export interface Executor<Program, Input, Request, Reply, Output, Failure = unknown> {
  start(
    program: Program,
    input: Input,
  ): Operation<
    ExecutionState<
      Execution<Request, Reply, Output, Failure>,
      ExecutionBoundary<Request, Output, Failure>
    >
  >;
}

/** Commands address one live operative; routing and durable command IDs are adapter-owned. */
export type ExecutionCommand<Reply> =
  | { readonly kind: "resume"; readonly suspensionId: SuspensionId; readonly reply: Reply }
  | { readonly kind: "cancel"; readonly reason?: string };

/** Transport/evaluator mechanics behind the shared execution state machine. */
export interface ExecutionDriver<Request, Reply, Output, Failure> {
  turn(command: ExecutionCommand<Reply>): Operation<ExecutionBoundary<Request, Output, Failure>>;
  /** Release must tolerate retry after failure/interruption, including partial release. */
  dispose(): Operation<void>;
  /** Synchronous domain validation before a command can reach the operative. */
  validateReply?(request: Request, reply: Reply): void;
}

/** The same per-execution discipline is used with or without checkpointing. */
function createDiscipline<Request, Reply, Output, Failure>(
  options: ExecutionOptions<Request, Reply, Output, Failure>,
) {
  let boundary = options.initial;
  let state: "ready" | "advancing" | "capturing" | "unknown" | "closed" = "ready";
  let disposal: "pending" | "running" | "done" = "pending";

  function assertReady() {
    if (state === "closed") {
      throw new Error("execution_closed");
    }
    if (state === "unknown") {
      throw new Error("execution_outcome_unknown");
    }
    if (state === "advancing" || state === "capturing") {
      throw new Error("execution_command_in_progress");
    }
  }

  function* advance(
    operation: () => Operation<ExecutionBoundary<Request, Output, Failure>>,
  ): Operation<ExecutionBoundary<Request, Output, Failure>> {
    state = "advancing";
    let received = false;
    try {
      boundary = yield* operation();
      received = true;
      return boundary;
    } finally {
      state = received ? "ready" : "unknown";
    }
  }

  const execution: Execution<Request, Reply, Output, Failure> = {
    *resume(suspensionId, reply) {
      assertReady();
      if (boundary.kind !== "suspended" || boundary.suspensionId !== suspensionId) {
        throw new Error("execution_suspension_mismatch");
      }
      options.validateReply?.(boundary.request, reply);
      return yield* advance(() => options.driver.resume(suspensionId, reply));
    },
    *cancel(reason) {
      assertReady();
      if (boundary.kind !== "suspended") {
        return boundary;
      }
      return yield* advance(() => options.driver.cancel(reason));
    },
    *dispose() {
      if (disposal === "done") {
        return;
      }
      if (disposal === "running" || state === "advancing" || state === "capturing") {
        throw new Error("execution_command_in_progress");
      }
      state = "closed";
      disposal = "running";
      let released = false;
      try {
        yield* options.driver.dispose();
        released = true;
      } finally {
        disposal = released ? "done" : "pending";
      }
    },
  };

  return {
    execution,
    *capture<Snapshot>(read: () => Operation<Snapshot>): Operation<Snapshot> {
      assertReady();
      state = "capturing";
      try {
        return yield* read();
      } finally {
        state = "ready";
      }
    },
  };
}

function composeExecution<Request, Reply, Output, Failure>(
  execution: Execution<Request, Reply, Output, Failure>,
  middleware: readonly OperationMiddleware<Execution<Request, Reply, Output, Failure>>[],
): Execution<Request, Reply, Output, Failure> {
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
export function createExecution<Request, Reply, Output, Failure = unknown>(
  options: ExecutionOptions<Request, Reply, Output, Failure>,
): ExecutionState<
  Execution<Request, Reply, Output, Failure>,
  ExecutionBoundary<Request, Output, Failure>
> {
  const discipline = createDiscipline(options);
  return {
    boundary: options.initial,
    execution: composeExecution(discipline.execution, options.middleware ?? []),
  };
}

/** Capture shares the same guard as advancement and disposal on this execution. */
export function createCheckpointExecution<Request, Reply, Output, Failure, Snapshot>(
  options: CheckpointExecutionOptions<Request, Reply, Output, Failure, Snapshot>,
): ExecutionState<
  CheckpointExecution<Request, Reply, Output, Failure, Snapshot>,
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
