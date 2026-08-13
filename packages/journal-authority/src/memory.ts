import type { Json } from "@sweatpants/foundation";
import { call, type Operation } from "effection";
import {
  ExecutionStoreError,
  type CommitExecutionRequest,
  type CommitExecutionResult,
  type ExecutionControl,
  type ExecutionObjectPointer,
  type ExecutionStore,
  type PrivateSegmentPointer,
  type StoredExecutionObject,
  type StoredPrivateSegment,
} from "./store.ts";

export function createMemoryExecutionStore(): ExecutionStore {
  const controls = new Map<string, ExecutionControl>();
  const journal = new Map<string, StoredPrivateSegment>();
  const replay = new Map<string, StoredPrivateSegment>();
  const objects = new Map<string, StoredExecutionObject>();

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function counter(value: string): bigint {
    if (!/^\d+$/.test(value)) throw new Error(`Invalid durable counter: ${value}`);
    return BigInt(value);
  }

  function next(value: string): string {
    return (counter(value) + 1n).toString(10);
  }

  function immutableSegment(
    target: Map<string, StoredPrivateSegment>,
    segment: StoredPrivateSegment,
  ): PrivateSegmentPointer {
    const existing = target.get(segment.segmentId);
    if (existing !== undefined) {
      if (existing.contentHash !== segment.contentHash) {
        throw new ExecutionStoreError(
          "immutable_object_conflict",
          `Segment ${segment.segmentId} has another content hash`,
        );
      }
      return { segmentId: existing.segmentId, lastSequence: existing.lastSequence };
    }
    target.set(segment.segmentId, clone(segment));
    return { segmentId: segment.segmentId, lastSequence: segment.lastSequence };
  }

  function putControl(request: CommitExecutionRequest): CommitExecutionResult {
    const current = controls.get(request.executionId) ?? null;
    if (current === null) {
      if (request.expectedControlRevision !== null || request.expectedOwnerFence !== "0") {
        return { status: "control_conflict", current: null };
      }
      for (const segment of request.journalSegments ?? []) immutableSegment(journal, segment);
      for (const segment of request.replaySegments ?? []) immutableSegment(replay, segment);
      const control: ExecutionControl = {
        ...clone(request.nextControl),
        controlRevision: "0",
        updatedAt: request.updatedAt,
      };
      controls.set(request.executionId, control);
      return { status: "committed", control: clone(control) };
    }
    if (current.ownerFence !== request.expectedOwnerFence) {
      return { status: "stale_owner", current: clone(current) };
    }
    if (current.controlRevision !== request.expectedControlRevision) {
      return { status: "control_conflict", current: clone(current) };
    }
    for (const segment of request.journalSegments ?? []) immutableSegment(journal, segment);
    for (const segment of request.replaySegments ?? []) immutableSegment(replay, segment);
    const control: ExecutionControl = {
      ...clone(request.nextControl),
      controlRevision: next(current.controlRevision),
      updatedAt: request.updatedAt,
    };
    controls.set(request.executionId, control);
    return { status: "committed", control: clone(control) };
  }

  function putObject(object: StoredExecutionObject): ExecutionObjectPointer {
    const existing = objects.get(object.objectId);
    if (existing !== undefined) {
      if (existing.contentHash !== object.contentHash) {
        throw new ExecutionStoreError(
          "immutable_object_conflict",
          `Object ${object.objectId} has another content hash`,
        );
      }
      return { objectId: existing.objectId };
    }
    objects.set(object.objectId, clone(object));
    return { objectId: object.objectId };
  }

  function chain(
    target: Map<string, StoredPrivateSegment>,
    task: { executionId: string; taskId: string; head: PrivateSegmentPointer | null },
  ): AsyncIterable<readonly Json[]> {
    return (async function* () {
      const ids: string[] = [];
      const seen = new Set<string>();
      let cursor = task.head;
      while (cursor !== null) {
        if (seen.has(cursor.segmentId)) {
          throw new ExecutionStoreError(
            "persisted_data_invalid",
            `Segment cycle ${cursor.segmentId}`,
          );
        }
        seen.add(cursor.segmentId);
        const segment = target.get(cursor.segmentId);
        if (
          segment === undefined ||
          segment.executionId !== task.executionId ||
          segment.taskId !== task.taskId
        ) {
          throw new ExecutionStoreError(
            "persisted_data_invalid",
            `Segment ${cursor.segmentId} is outside task scope`,
          );
        }
        ids.push(segment.segmentId);
        cursor = segment.previous;
      }
      for (let index = ids.length - 1; index >= 0; index -= 1) {
        yield clone(target.get(ids[index]!)!.entries);
      }
    })();
  }

  return {
    *loadControl(executionId): Operation<ExecutionControl | null> {
      return yield* call(() => clone(controls.get(executionId) ?? null));
    },
    *commitExecution(request): Operation<CommitExecutionResult> {
      return yield* call(() => putControl(request));
    },
    *putObject(object): Operation<ExecutionObjectPointer> {
      return yield* call(() => putObject(object));
    },
    *getObject(pointer): Operation<StoredExecutionObject | null> {
      return yield* call(() => clone(objects.get(pointer.objectId) ?? null));
    },
    *appendJournalSegment(segment): Operation<PrivateSegmentPointer> {
      return yield* call(() => immutableSegment(journal, segment));
    },
    *appendReplaySegment(segment): Operation<PrivateSegmentPointer> {
      return yield* call(() => immutableSegment(replay, segment));
    },
    *readJournal(task): Operation<AsyncIterable<readonly Json[]>> {
      return chain(journal, task);
    },
    *readReplay(task): Operation<AsyncIterable<readonly Json[]>> {
      return chain(replay, task);
    },
  };
}
