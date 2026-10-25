import type { Operation } from "effection";
import { CrankError, type ReplayItem } from "@sweatpants/durable-execution";
import {
  AcceptedExtensionUnavailable,
  type JournalAuthorityContract,
  type OrphanFence,
} from "../contract/authority-contract.ts";
import type { ExecutionComposition } from "./execution-composition.ts";

export type FailureSite =
  | "reconstruction"
  | "live"
  | "acknowledgement"
  | "observation"
  | "validation";
export class ActivationFailure {
  constructor(
    readonly original: unknown,
    readonly site: FailureSite,
  ) {}
  get orphan(): boolean {
    return (
      ["reconstruction", "observation", "validation"].includes(this.site) &&
      this.original instanceof CrankError &&
      this.original.code === "replay_diverged" &&
      !(this.original instanceof AcceptedExtensionUnavailable)
    );
  }
}
type Ownership =
  | { kind: "unbound" | "settled"; fence: OrphanFence }
  | { kind: "bound"; fence: OrphanFence; execution: ExecutionComposition };

/** The host alone owns durable failure disposition; never refresh from observation. */
export function createActivationLifetime(authority: JournalAuthorityContract, item: ReplayItem) {
  let ownership: Ownership = {
    kind: "unbound",
    fence: {
      address: item.address,
      program: item.program,
      executionEpoch: item.executionEpoch,
      forkGroupRevision: item.groupContext.groupRevision,
    },
  };
  return {
    bound(execution: ExecutionComposition) {
      const { mandate } = execution;
      ownership = {
        kind: "bound",
        execution,
        fence: {
          address: mandate.address,
          program: mandate.program,
          executionEpoch: mandate.lease.epoch,
          forkGroupRevision: mandate.groupContext.groupRevision,
        },
      };
    },
    settled() {
      ownership = { kind: "settled", fence: ownership.fence };
    },
    *failed(failure: ActivationFailure): Operation<void> {
      if (ownership.kind === "bound") {
        try {
          yield* ownership.execution.release("failed");
        } catch {
          /* Preserve primary. */
        }
      }
      if (failure.orphan) {
        try {
          yield* authority.command({
            type: "execution.orphan-if-current",
            request: { fence: ownership.fence, reason: "replay_diverged" },
          });
        } catch {
          /* Preserve primary; disposition is not proof of committed cleanup. */
        }
      }
    },
  };
}
