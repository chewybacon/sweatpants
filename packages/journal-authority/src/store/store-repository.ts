import {
  DURABLE_SCAN_MAX_BYTES,
  DURABLE_SCAN_MAX_RECORDS,
  DurableCollections,
  DurableIndexes,
  durableKey,
  decodeDurableKey,
  type DurableKernel,
  type DurableMutationOutcome,
  type StoredScanPage,
  type StoredAuthorityRecord,
} from "@sweatpants/durable-storage-kernel";
import type { Json } from "@sweatpants/foundation";
import { call, type Operation } from "effection";
import {
  ExecutionStoreError,
  type CommitExecutionResult,
  type ExecutionControl,
  type ExecutionObjectPointer,
  type ExecutionStore,
  type PrivateSegmentPointer,
  type StoredExecutionObject,
  type StoredPrivateSegment,
} from "./store.ts";
import {
  decodeAuthorityControl,
  readExecutionObject,
  readPrivateSegment,
  prepareExecutionObject,
  executionKeys,
} from "./store-persistence.ts";
import { planExecutionCommit, privateSegmentEnsure } from "./store-planners.ts";

function immutableConflict(
  outcome: Extract<DurableMutationOutcome, { status: "immutable_conflict" }>,
): never {
  throw new ExecutionStoreError(
    "immutable_object_conflict",
    `Immutable execution write ${outcome.write} conflicts with ${outcome.existing.key}`,
  );
}

function counter(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new ExecutionStoreError("persisted_data_invalid", `${field} is not a durable counter`);
  }
  return BigInt(value);
}

export function createKernelExecutionStore(kernel: DurableKernel): ExecutionStore {
  // A load followed by a commit need not fetch the same expected revision again.
  // This is only a planning input: the kernel still atomically checks its CAS.
  let observed: { executionId: string; record: StoredAuthorityRecord | null } | undefined;
  // IDs and selected chain heads name immutable content. Keep only the most
  // recent small read of each kind; misses and mutable control are never cached.
  const retainedReadBytes = 1024 * 1024;
  const objectReads = new Map<string, StoredExecutionObject>();
  let objectReadBytes = 0;
  let chainRead: { key: string; chunks: readonly (readonly Json[])[] } | undefined;
  function chainValues(chunks: readonly (readonly Json[])[]): AsyncIterable<readonly Json[]> {
    return (async function* () {
      for (const chunk of chunks) {
        yield structuredClone(chunk);
      }
    })();
  }

  function* loadControl(executionId: string): Operation<ExecutionControl | null> {
    const record = yield* kernel.readAuthority(
      DurableCollections.executionControls,
      executionKeys.control(executionId),
    );
    observed = { executionId, record };
    return record === null ? null : decodeAuthorityControl(record);
  }

  function* putSegment(
    kind: "journal" | "replay",
    segment: StoredPrivateSegment,
  ): Operation<PrivateSegmentPointer> {
    const ensure = privateSegmentEnsure(kind, segment);
    const outcome = yield* kernel.apply({ ensures: [ensure] });
    if (outcome.status === "immutable_conflict") {
      return immutableConflict(outcome);
    }
    if (outcome.status !== "committed") {
      throw new ExecutionStoreError(
        "persisted_data_invalid",
        `Segment staging returned ${outcome.status}`,
      );
    }
    const record = outcome.ensured[ensure.name];
    if (!record) {
      throw new ExecutionStoreError(
        "persisted_data_invalid",
        `Segment staging omitted ${ensure.name}`,
      );
    }
    const stored = yield* call(() => readPrivateSegment(record.value));
    return { segmentId: stored.segmentId, lastSequence: stored.lastSequence };
  }

  function* loadChain(
    kind: "journal" | "replay",
    task: {
      readonly executionId: string;
      readonly taskId: string;
      readonly head: PrivateSegmentPointer | null;
    },
  ): Operation<AsyncIterable<readonly Json[]>> {
    if (task.head === null) {
      return (async function* () {})();
    }
    const collection =
      kind === "journal"
        ? DurableCollections.executionJournalSegments
        : DurableCollections.executionReplaySegments;
    const readKey = JSON.stringify([kind, task.executionId, task.taskId, task.head]);
    if (chainRead?.key === readKey) {
      return chainValues(chainRead.chunks);
    }
    const chunks: Array<readonly Json[]> = [];
    let readBytes = 0;
    let after: string | null = null;
    let expected: bigint | null = null;
    let previousSegmentId: string | null = null;
    let finalSegment: StoredPrivateSegment | null = null;
    do {
      const page: StoredScanPage = yield* kernel.scan({
        collection,
        index: DurableIndexes.taskSequence,
        scope: durableKey(task.executionId, task.taskId),
        direction: "forward",
        after,
        through: task.head.lastSequence,
        maxRecords: DURABLE_SCAN_MAX_RECORDS,
        maxPayloadBytes: DURABLE_SCAN_MAX_BYTES,
      });
      for (const record of page.records) {
        const segment = yield* call(() => readPrivateSegment(record.value));
        if (segment.executionId !== task.executionId || segment.taskId !== task.taskId) {
          throw new ExecutionStoreError(
            "persisted_data_invalid",
            `${kind} segment ${segment.segmentId} is outside task scope`,
          );
        }
        const first = counter(segment.firstSequence, "first sequence");
        if (
          (expected !== null && first !== expected) ||
          (segment.previous?.segmentId ?? null) !== previousSegmentId
        ) {
          throw new ExecutionStoreError(
            "persisted_data_invalid",
            `${kind} segment ${segment.segmentId} breaks the selected task chain`,
          );
        }
        expected = counter(segment.lastSequence, "last sequence") + 1n;
        previousSegmentId = segment.segmentId;
        finalSegment = segment;
        // The storage read owns these entries until the iterable yields.
        chunks.push(segment.entries);
        readBytes += segment.encodedBytes;
      }
      after = page.nextCursor;
    } while (after !== null);
    if (
      finalSegment?.segmentId !== task.head.segmentId ||
      finalSegment.lastSequence !== task.head.lastSequence
    ) {
      throw new ExecutionStoreError(
        "persisted_data_invalid",
        `${kind} scan did not reach selected head ${task.head.segmentId}`,
      );
    }
    chainRead = readBytes <= retainedReadBytes ? { key: readKey, chunks } : undefined;
    return chainValues(chunks);
  }

  return {
    *loadControl(executionId): Operation<ExecutionControl | null> {
      return yield* loadControl(executionId);
    },
    *commitExecution(request): Operation<CommitExecutionResult> {
      const prior = observed;
      observed = undefined;
      const currentRecord =
        prior?.executionId === request.executionId &&
        (prior.record?.revision ?? null) === request.expectedControlRevision &&
        (prior.record?.fence ?? "0") === request.expectedOwnerFence
          ? prior.record
          : yield* kernel.readAuthority(
              DurableCollections.executionControls,
              executionKeys.control(request.executionId),
            );
      const decision = planExecutionCommit({ request, currentRecord });
      if (decision.kind === "complete") {
        return decision.result;
      }
      const outcome = yield* kernel.apply(decision.mutation);
      if (outcome.status === "committed") {
        if (outcome.authority === null) {
          throw new ExecutionStoreError(
            "persisted_data_invalid",
            "Execution commit omitted its control result",
          );
        }
        for (const key of decision.mutation.retireExecutionObjects ?? []) {
          const [objectId] = decodeDurableKey(key);
          const retained = objectReads.get(objectId!);
          if (retained) {
            objectReadBytes -= retained.byteLength;
            objectReads.delete(objectId!);
          }
        }
        observed = { executionId: request.executionId, record: outcome.authority };
        return { status: "committed", control: decodeAuthorityControl(outcome.authority) };
      }
      if (outcome.status === "authority_conflict") {
        const current = outcome.current === null ? null : decodeAuthorityControl(outcome.current);
        if (outcome.mismatch === "fence" && current !== null) {
          return { status: "stale_owner", current };
        }
        return { status: "control_conflict", current };
      }
      if (outcome.status === "immutable_conflict") {
        return immutableConflict(outcome);
      }
      throw new ExecutionStoreError(
        "persisted_data_invalid",
        `Execution commit unexpectedly returned ${outcome.status}`,
      );
    },
    *putObject(object): Operation<ExecutionObjectPointer> {
      const objectId = object.objectId;
      const name = "execution-object";
      const outcome = yield* kernel.apply({
        ensures: [
          {
            name,
            collection: DurableCollections.executionObjects,
            key: executionKeys.object(object.objectId),
            fingerprint: object.contentHash,
            value: prepareExecutionObject(object),
          },
        ],
      });
      if (outcome.status === "immutable_conflict") {
        return immutableConflict(outcome);
      }
      if (outcome.status !== "committed") {
        throw new ExecutionStoreError(
          "persisted_data_invalid",
          `Object ensure returned ${outcome.status}`,
        );
      }
      const record = outcome.ensured[name];
      if (!record) {
        throw new ExecutionStoreError("persisted_data_invalid", "Object ensure omitted its result");
      }
      // This ensure has one primary key and no aliases. A successful commit
      // acknowledges that identity; decoding its body adds no identity evidence.
      return { objectId };
    },
    *getObject(pointer): Operation<StoredExecutionObject | null> {
      const retained = objectReads.get(pointer.objectId);
      if (retained) {
        return structuredClone(retained);
      }
      const record = yield* kernel.readImmutable(
        DurableCollections.executionObjects,
        executionKeys.object(pointer.objectId),
      );
      if (record === null) {
        return null;
      }
      const object = yield* call(() => readExecutionObject(record.value));
      if (!objectReads.has(object.objectId) && object.byteLength <= retainedReadBytes) {
        while (objectReads.size >= 4 || objectReadBytes + object.byteLength > retainedReadBytes) {
          const oldest = objectReads.keys().next().value!;
          objectReadBytes -= objectReads.get(oldest)!.byteLength;
          objectReads.delete(oldest);
        }
        objectReads.set(object.objectId, object);
        objectReadBytes += object.byteLength;
      }
      return structuredClone(object);
    },
    *appendJournalSegment(segment): Operation<PrivateSegmentPointer> {
      return yield* putSegment("journal", segment);
    },
    *appendReplaySegment(segment): Operation<PrivateSegmentPointer> {
      return yield* putSegment("replay", segment);
    },
    *readJournal(task): Operation<AsyncIterable<readonly Json[]>> {
      try {
        return yield* loadChain("journal", task);
      } catch (error) {
        // Preserve the stream contract: persisted-chain failures surface when
        // the returned iterable is consumed. Storage conformance observes it.
        return (async function* () {
          throw error;
        })();
      }
    },
    *readReplay(task): Operation<AsyncIterable<readonly Json[]>> {
      try {
        return yield* loadChain("replay", task);
      } catch (error) {
        // Preserve the stream contract; see readJournal above.
        return (async function* () {
          throw error;
        })();
      }
    },
  };
}
