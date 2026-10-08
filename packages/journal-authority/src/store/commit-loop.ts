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
      readonly onCommitted?: (control: ExecutionControl) => void;
      readonly result: Result;
    };

/** The sole bounded execution-control CAS loop. */
export function* runExecutionCommitLoop<Result>(
  store: Pick<ExecutionStore, "loadControl" | "commitExecution">,
  executionId: string,
  evaluate: (current: ExecutionControl | null) => Operation<ExecutionCommitDecision<Result>>,
  maximumAttempts = 64,
  initialControl?: ExecutionControl,
): Operation<Result> {
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const optimistic = attempt === 0 && initialControl !== undefined;
    const current = optimistic ? initialControl : yield* store.loadControl(executionId);
    let decision: ExecutionCommitDecision<Result>;
    try {
      decision = yield* evaluate(current);
    } catch (error) {
      if (!optimistic) throw error;
      const latest = yield* store.loadControl(executionId);
      if (
        latest?.controlRevision === current?.controlRevision &&
        latest?.ownerFence === current?.ownerFence
      )
        throw error;
      // The rejection described a replaced view. Reevaluate the actual state;
      // a genuine rejection against that state is still surfaced to the caller.
      continue;
    }
    if (decision.status === "return") {
      // No CAS will check a no-op, so confirm the read before returning it.
      if (optimistic) {
        const latest = yield* store.loadControl(executionId);
        if (
          latest?.controlRevision !== current?.controlRevision ||
          latest?.ownerFence !== current?.ownerFence
        )
          continue;
      }
      return decision.result;
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
      decision.onCommitted?.(committed.control);
      return decision.result;
    }
    if (committed.status === "stale_owner" && !optimistic) {
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
