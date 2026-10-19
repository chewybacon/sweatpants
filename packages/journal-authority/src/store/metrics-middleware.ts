import type { Operation } from "effection";
import type { ExecutionId } from "@sweatpants/durable-execution";
import { ExecutionStoreApi } from "../api.ts";

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

/** Observation-only middleware for the direct ExecutionStore contract. */
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
    *loadControl([executionId], next) {
      executionReads += 1;
      executionsTouched.add(executionId);
      const control = yield* next(executionId);
      resumeBytes += size(control);
      return control;
    },
    *commitExecution([request], next) {
      executionCommits += 1;
      executionsTouched.add(request.executionId);
      mutationBytes += size({
        control: request.nextControl,
        journalSegments: request.journalSegments,
        replaySegments: request.replaySegments,
      });
      return yield* next(request);
    },
    *putObject([object], next) {
      mutationBytes += object.byteLength;
      const pointer = yield* next(object);
      return pointer;
    },
    *getObject([pointer], next) {
      const object = yield* next(pointer);
      resumeBytes += size(object);
      return object;
    },
    *appendReplaySegment([segment], next) {
      replayAppends += 1;
      executionsTouched.add(segment.executionId);
      mutationBytes += segment.encodedBytes;
      const pointer = yield* next(segment);
      if (replayObjects.has(pointer.segmentId)) {
        replayObjectsRewritten += 1;
      }
      replayObjects.add(pointer.segmentId);
      return pointer;
    },
    *readReplay([task], next) {
      replayReads += 1;
      const stream = yield* next(task);
      return (async function* () {
        for await (const entries of stream) {
          resumeBytes += size(entries);
          yield entries;
        }
      })();
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
      replayObjects.clear();
    },
  };
}
