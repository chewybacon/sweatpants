import { CrankError, type ExecutionId } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type { ExecutionStore, VersionedExecution } from "./store.ts";

export type ExecutionCommitDecision<Result> =
  | { readonly status: "return"; readonly result: Result }
  | {
      readonly status: "commit";
      readonly next: Parameters<ExecutionStore["commitExecution"]>[0]["next"];
      readonly privateRecords: readonly Json[];
      readonly result: Result;
    };

/**
 * The sole authority CAS loop.
 *
 * Domain evaluation is rerun only after an explicit storage conflict. Adapter
 * failures propagate unchanged, and Effection cancellation stops the loop.
 */
export function* runExecutionCommitLoop<Result>(
  store: Pick<ExecutionStore, "loadExecution" | "commitExecution">,
  executionId: ExecutionId,
  evaluate: (current: VersionedExecution | null) => Operation<ExecutionCommitDecision<Result>>,
  maximumAttempts = 64,
): Operation<Result> {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const current = yield* store.loadExecution(executionId);
    const decision = yield* evaluate(current);
    if (decision.status === "return") return decision.result;
    const committed = yield* store.commitExecution({
      executionId,
      expectedRevision: current?.revision ?? null,
      next: decision.next,
      privateRecords: decision.privateRecords,
    });
    if (committed.status === "accepted") return decision.result;
  }
  throw new CrankError(
    "cas_contention",
    "Execution Store contention exceeded the authority retry budget",
  );
}
