import type { Operation } from "effection";
import type { ExecutionId } from "@sweatpants/durable-execution";
import { ExecutionStoreApi } from "./api.ts";

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

export interface StorageMetricsRecorder {
  metrics(): StorageMetrics;
  reset(): void;
}

function size(value: unknown): number {
  return JSON.stringify(value ?? null)?.length ?? 0;
}

/**
 * Installs observation-only metrics middleware for the calling scope.
 *
 * The middleware records evidence and delegates every call unchanged, so
 * removing it cannot alter an accepted storage result.
 */
export function* installStorageMetrics(): Operation<StorageMetricsRecorder> {
  let executionReads = 0;
  let executionCommits = 0;
  let replayAppends = 0;
  let replayReads = 0;
  let replayObjectsRewritten = 0;
  let mutationBytes = 0;
  let resumeBytes = 0;
  const executionsTouched = new Set<ExecutionId>();
  const replayObjects = new Set<string>();

  yield* ExecutionStoreApi.around({
    *loadExecution([executionId], next) {
      executionReads += 1;
      executionsTouched.add(executionId);
      const record = yield* next(executionId);
      resumeBytes += size(record);
      return record;
    },
    *commitExecution([request], next) {
      executionCommits += 1;
      executionsTouched.add(request.executionId);
      mutationBytes += size(request.next);
      return yield* next(request);
    },
    *putPayload([value], next) {
      mutationBytes += size(value);
      return yield* next(value);
    },
    *getPayload([reference], next) {
      const value = yield* next(reference);
      resumeBytes += size(value);
      return value;
    },
    *appendReplay([request], next) {
      replayAppends += 1;
      executionsTouched.add(request.executionId);
      mutationBytes += size(request.entries);
      const reference = yield* next(request);
      if (replayObjects.has(reference.id)) {
        replayObjectsRewritten += 1;
      }
      replayObjects.add(reference.id);
      return reference;
    },
    *readReplay([head], next) {
      replayReads += 1;
      const entries = yield* next(head);
      resumeBytes += size(entries);
      return entries;
    },
  });

  return {
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
    },
  };
}
