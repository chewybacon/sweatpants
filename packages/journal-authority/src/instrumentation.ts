import { call, type Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { DurableReference, ExecutionId } from "@sweatpants/durable-execution";
import type {
  AppendReplayRequest,
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionStore,
  VersionedExecution,
} from "./store.ts";

export interface StorageMetrics {
  readonly executionReads: number;
  readonly executionCommits: number;
  readonly replayAppends: number;
  readonly replayReads: number;
  readonly executionsTouched: readonly ExecutionId[];
  readonly replayObjectsRewritten: number;
  readonly mutationBytes: number;
  readonly resumeBytes: number;
}

export interface InstrumentedExecutionStore extends ExecutionStore {
  metrics(): StorageMetrics;
  reset(): void;
}

/** Wraps any store driver to certify bounded read/write behavior. */
export function instrumentExecutionStore(inner: ExecutionStore): InstrumentedExecutionStore {
  let executionReads = 0;
  let executionCommits = 0;
  let replayAppends = 0;
  let replayReads = 0;
  let replayObjectsRewritten = 0;
  let mutationBytes = 0;
  let resumeBytes = 0;
  const executionsTouched = new Set<ExecutionId>();
  const replayObjects = new Set<string>();

  function size(value: unknown): number {
    return JSON.stringify(value ?? null)?.length ?? 0;
  }

  return {
    *loadExecution(executionId): Operation<VersionedExecution | null> {
      executionReads += 1;
      executionsTouched.add(executionId);
      const record = yield* inner.loadExecution(executionId);
      resumeBytes += size(record);
      return record;
    },
    *commitExecution(request: CommitExecutionRequest): Operation<CommitExecutionResult> {
      executionCommits += 1;
      executionsTouched.add(request.executionId);
      mutationBytes += size(request.next);
      return yield* inner.commitExecution(request);
    },
    *putPayload(value): Operation<DurableReference> {
      mutationBytes += size(value);
      return yield* inner.putPayload(value);
    },
    *getPayload(reference): Operation<Json | Uint8Array | null> {
      const value = yield* inner.getPayload(reference);
      resumeBytes += size(value);
      return value;
    },
    *appendReplay(request: AppendReplayRequest): Operation<DurableReference> {
      replayAppends += 1;
      executionsTouched.add(request.executionId);
      mutationBytes += size(request.entries);
      const reference = yield* inner.appendReplay(request);
      if (replayObjects.has(reference.id)) {
        replayObjectsRewritten += 1;
      }
      replayObjects.add(reference.id);
      return reference;
    },
    *readReplay(head): Operation<readonly Json[]> {
      replayReads += 1;
      const entries = yield* inner.readReplay(head);
      resumeBytes += size(entries);
      return entries;
    },
    metrics(): StorageMetrics {
      return {
        executionReads,
        executionCommits,
        replayAppends,
        replayReads,
        executionsTouched: [...executionsTouched],
        replayObjectsRewritten,
        mutationBytes,
        resumeBytes,
      };
    },
    reset(): void {
      executionReads = 0;
      executionCommits = 0;
      replayAppends = 0;
      replayReads = 0;
      replayObjectsRewritten = 0;
      mutationBytes = 0;
      resumeBytes = 0;
      executionsTouched.clear();
      void call;
    },
  };
}
