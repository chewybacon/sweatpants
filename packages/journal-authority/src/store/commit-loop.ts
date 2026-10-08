import { CrankError } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import type {
  ExecutionControl,
  ExecutionStore,
  StoredPrivateSegment,
  StoredExecutionObject,
} from "./store.ts";

export type ExecutionCommitDecision<Result> =
  | { readonly status: "return"; readonly result: Result }
  | {
      readonly status: "commit";
      readonly next: Omit<ExecutionControl, "controlRevision" | "updatedAt">;
      readonly journalSegments?: readonly StoredPrivateSegment[];
      readonly replaySegments?: readonly StoredPrivateSegment[];
      readonly objects?: readonly StoredExecutionObject[];
      readonly result: Result;
    };

export type ExecutionCommitOutcome<Result> =
  | { readonly status: "returned"; readonly result: Result }
  | {
      readonly status: "committed";
      readonly result: Result;
      readonly control: ExecutionControl;
    };

/** The sole bounded execution-control CAS loop. Returns only the winning decision. */
export function* runExecutionCommitLoop<Result>(
  store: Pick<ExecutionStore, "loadControl" | "commitExecution">,
  executionId: string,
  evaluate: (current: ExecutionControl | null) => Operation<ExecutionCommitDecision<Result>>,
  maximumAttempts = 64,
): Operation<ExecutionCommitOutcome<Result>> {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const current = yield* store.loadControl(executionId);
    const decision = yield* evaluate(current);
    if (decision.status === "return") {
      return { status: "returned", result: decision.result };
    }
    const committed = yield* store.commitExecution({
      executionId,
      expectedControlRevision: current?.controlRevision ?? null,
      expectedOwnerFence: current?.ownerFence ?? "0",
      nextControl: decision.next,
      ...(decision.journalSegments ? { journalSegments: decision.journalSegments } : {}),
      ...(decision.replaySegments ? { replaySegments: decision.replaySegments } : {}),
      objects: decision.objects,
      updatedAt: Date.now(),
    });
    if (committed.status === "committed") {
      return { status: "committed", result: decision.result, control: committed.control };
    }
    if (committed.status === "stale_owner") {
      throw new CrankError("stale_owner", `Execution ${executionId} lost its owner fence`);
    }
  }
  throw new CrankError(
    "cas_contention",
    "Execution Store contention exceeded the authority retry budget",
  );
}

export function inlineControl(
  executionId: string,
  rootTaskId: string,
  status: ExecutionControl["status"],
  control: Json,
  ownerFence: string,
  stopGeneration = "0",
  requestedDisposition: ExecutionControl["requestedDisposition"] = null,
): Omit<ExecutionControl, "controlRevision" | "updatedAt"> {
  return {
    executionId,
    ownerFence,
    status,
    rootTaskId,
    stopGeneration,
    requestedDisposition,
    control,
  };
}
