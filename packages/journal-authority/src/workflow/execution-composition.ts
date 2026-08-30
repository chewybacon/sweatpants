import { type Operation } from "effection";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type {
  DurableOperationDescriptor,
  EmissionDescriptor,
  Mandate,
} from "@sweatpants/durable-execution";

import type { JournalAuthorityContract } from "../contract/authority-contract.ts";
import type {
  CompleteTaskResult,
  DurableCancellationState,
  EmissionReceipt,
  LiveReservationResult,
  ResolveOperationResult,
} from "../contract/authority-types.ts";

/**
 * Relative live surface carried by one Mandate (REQ-018, REQ-067/068).
 * Consumers cannot submit addressing, placement, capability clumps, action
 * indexes, or pull ordinals; the issuer fixed those facts already.
 */
export interface ExecutionComposition {
  readonly mandate: Mandate;
  reserve(descriptor: DurableOperationDescriptor): Operation<LiveReservationResult>;
  emit(descriptor: EmissionDescriptor): Operation<EmissionReceipt>;
  complete(outcome: OperationOutcome): Operation<CompleteTaskResult>;
  resolve(request: {
    readonly capability: string;
    readonly audience: string;
    readonly outcome: OperationOutcome;
  }): Operation<ResolveOperationResult>;
  identity(): Operation<{ readonly id: string; readonly incarnation: string }>;
  cancellation(): Operation<DurableCancellationState>;
  beginCancellationUnwind(): Operation<DurableCancellationState>;
  release(reason: "failed" | "scope_exit"): Operation<void>;
}

export function executionComposition(
  authority: JournalAuthorityContract,
  mandate: Mandate,
): ExecutionComposition {
  return {
    mandate,
    *reserve(descriptor) {
      return yield* authority.command({
        type: "execution.mandate-reserve",
        request: { mandate, descriptor },
      });
    },
    *emit(descriptor) {
      return yield* authority.command({
        type: "execution.mandate-emission",
        request: { mandate, descriptor },
      });
    },
    *complete(outcome) {
      return yield* authority.command({
        type: "execution.mandate-complete",
        request: { mandate, outcome },
      });
    },
    *resolve(request) {
      return yield* authority.command({ type: "execution.resolve-pull", request });
    },
    *identity() {
      return yield* authority.query({ type: "authority.identity" });
    },
    *cancellation() {
      return yield* authority.query({
        type: "task.cancellation-state",
        sessionId: mandate.address.sessionId,
        taskId: mandate.address.taskId,
      });
    },
    *beginCancellationUnwind() {
      return yield* authority.command({
        type: "execution.begin-cancellation-unwind",
        request: {
          sessionId: mandate.address.sessionId,
          taskId: mandate.address.taskId,
        },
      });
    },
    *release(reason) {
      yield* authority.command({
        type: "execution.release-mandate",
        request: { mandate, reason },
      });
    },
  };
}
