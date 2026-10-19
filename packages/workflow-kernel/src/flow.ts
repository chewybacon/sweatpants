import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import { DurableProgramCancellation } from "@sweatpants/durable-execution";
import type { ExchangeReply, WorkflowExecutionState, WorkflowFlow } from "./index.ts";

/** An uncaught guest failure, distinct from an exchange/transport failure. */
export class WorkflowFailure extends Error {
  readonly value: Json;

  constructor(value: Json) {
    super(JSON.stringify(value));
    this.name = "WorkflowFailure";
    this.value = value;
  }
}

/**
 * Runs a resumable guest as a callable Flow. The owner supplies fresh or restored
 * startup and retains the execution for capture/disposal, including after return.
 * Neither this generator nor exchange middleware is part of the checkpoint.
 */
export function createWorkflowFlow(
  start: (input: Json) => Operation<WorkflowExecutionState>,
): WorkflowFlow {
  return function* (input, exchange) {
    const { execution, boundary: initial } = yield* start(input);
    let boundary = initial;
    while (boundary.kind === "suspended") {
      let reply: ExchangeReply;
      try {
        reply = yield* exchange(boundary.request);
      } catch (error) {
        if (!(error instanceof DurableProgramCancellation)) {
          throw error;
        }
        // Logical cancellation belongs to the guest. It may yield more exchanges
        // while unwinding; scope teardown never implicitly requests this unwind.
        boundary = yield* execution.cancel(error.reason);
        continue;
      }
      boundary = yield* execution.resume(boundary.suspensionId, reply);
    }
    if (boundary.kind === "failed") {
      throw new WorkflowFailure(boundary.error);
    }
    if (boundary.kind === "cancelled") {
      throw new DurableProgramCancellation(boundary.reason);
    }
    return boundary.value;
  };
}
