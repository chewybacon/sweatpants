import type { Operation } from "effection";

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
export interface ExecutionState<Request, Reply, Output, Failure = unknown> {
  readonly execution: Execution<Request, Reply, Output, Failure>;
  readonly boundary: ExecutionBoundary<Request, Output, Failure>;
}

export interface Executor<Program, Input, Request, Reply, Output, Failure = unknown> {
  start(program: Program, input: Input): Operation<ExecutionState<Request, Reply, Output, Failure>>;
}

/** Commands address one live operative; routing and durable command IDs are adapter-owned. */
export type ExecutionCommand<Reply> =
  | { readonly kind: "resume"; readonly suspensionId: SuspensionId; readonly reply: Reply }
  | { readonly kind: "cancel"; readonly reason?: string };

/** Transport/evaluator mechanics behind the shared execution state machine. */
export interface ExecutionDriver<Request, Reply, Output, Failure> {
  turn(command: ExecutionCommand<Reply>): Operation<ExecutionBoundary<Request, Output, Failure>>;
  dispose(): Operation<void>;
  /** Synchronous domain validation before a command can reach the operative. */
  validateReply?(request: Request, reply: Reply): void;
}

/**
 * Owns the live principal–operative command discipline. Does not retry commands.
 * After interruption or transport failure, only disposal is safe on this handle.
 */
export function createExecution<Request, Reply, Output, Failure>(
  initial: ExecutionBoundary<Request, Output, Failure>,
  driver: ExecutionDriver<Request, Reply, Output, Failure>,
): ExecutionState<Request, Reply, Output, Failure> {
  let boundary = initial;
  let state: "ready" | "advancing" | "unknown" | "closed" = "ready";

  function assertReady() {
    if (state === "closed") throw new Error("execution_closed");
    if (state === "unknown") throw new Error("execution_outcome_unknown");
    if (state === "advancing") throw new Error("execution_command_in_progress");
  }

  function* turn(
    command: ExecutionCommand<Reply>,
  ): Operation<ExecutionBoundary<Request, Output, Failure>> {
    assertReady();
    if (command.kind === "resume") {
      if (boundary.kind !== "suspended" || boundary.suspensionId !== command.suspensionId)
        throw new Error("execution_suspension_mismatch");
      driver.validateReply?.(boundary.request, command.reply);
    } else if (boundary.kind !== "suspended") {
      return boundary;
    }
    state = "advancing";
    let received = false;
    try {
      boundary = yield* driver.turn(command);
      received = true;
      return boundary;
    } finally {
      // Effection cancellation unwinds without throwing through catch.
      state = received ? "ready" : "unknown";
    }
  }

  return {
    boundary: initial,
    execution: {
      resume: (suspensionId, reply) => turn({ kind: "resume", suspensionId, reply }),
      cancel: (reason) => turn({ kind: "cancel", ...(reason === undefined ? {} : { reason }) }),
      *dispose() {
        if (state === "closed") return;
        if (state === "advancing") throw new Error("execution_command_in_progress");
        state = "closed";
        yield* driver.dispose();
      },
    },
  };
}
