import type { Operation } from "effection";
import type {
  Exchange,
  Execution,
  ExecutionBoundary,
  ExecutionState,
} from "@sweatpants/foundation";

/**
 * Experiment: one handoff using existing types, without a task protocol.
 * The caller owns lifetime and serializes calls for this execution. Distinct
 * executions may call the same exchange concurrently. This helper does not
 * provide authority, cancellation, capture, or a shared-heap scheduler.
 */
export function* handoff<Request, Reply, Output, Failure>(
  state: ExecutionState<
    Execution<Request, Reply, Output, Failure>,
    ExecutionBoundary<Request, Output, Failure>
  >,
  exchange: Exchange<Request, Reply>,
): Operation<ExecutionBoundary<Request, Output, Failure>> {
  const { execution, boundary } = state;
  if (boundary.kind !== "suspended") {
    return boundary;
  }
  const reply = yield* exchange(boundary.request);
  return yield* execution.resume(boundary.suspensionId, reply);
}
