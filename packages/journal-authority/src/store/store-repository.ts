import {
  DURABLE_SCAN_MAX_BYTES,
  DURABLE_SCAN_MAX_RECORDS,
  DurableCollections,
  DurableIndexes,
  durableKey,
  type DurableKernel,
  type DurableMutationOutcome,
  type StoredScanPage,
} from "@sweatpants/durable-storage-kernel";
import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
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
  decodeExecutionObject,
  decodePrivateSegment,
  encodeExecutionObject,
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
  function* loadControl(executionId: string): Operation<ExecutionControl | null> {
    const record = yield* kernel.readAuthority(
      DurableCollections.executionControls,
      executionKeys.control(executionId),
    );
    return record === null ? null : decodeAuthorityControl(record);
  }

  function* putSegment(
    kind: "journal" | "replay",
    segment: StoredPrivateSegment,
  ): Operation<PrivateSegmentPointer> {
    const collection =
      kind === "journal"
        ? DurableCollections.executionJournalSegments
        : DurableCollections.executionReplaySegments;
    const existing = yield* kernel.readImmutable(
      collection,
      executionKeys.segment(segment.segmentId),
    );
    if (existing !== null) {
      if (existing.fingerprint !== segment.contentHash) {
        throw new ExecutionStoreError(
          "immutable_object_conflict",
          `${kind} segment ${segment.segmentId} has another content hash`,
        );
      }
      const stored = decodePrivateSegment(existing.value);
      return { segmentId: stored.segmentId, lastSequence: stored.lastSequence };
    }
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
    const stored = decodePrivateSegment(record.value);
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
    const chunks: Array<readonly Json[]> = [];
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
        maxStoredBytes: DURABLE_SCAN_MAX_BYTES,
      });
      for (const record of page.records) {
        const segment = decodePrivateSegment(record.value);
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
        chunks.push(structuredClone(segment.entries));
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
    return (async function* () {
      yield* chunks;
    })();
  }

  return {
    *loadControl(executionId): Operation<ExecutionControl | null> {
      return yield* loadControl(executionId);
    },
    *commitExecution(request): Operation<CommitExecutionResult> {
      const currentRecord = yield* kernel.readAuthority(
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
      const existing = yield* kernel.readImmutable(
        DurableCollections.executionObjects,
        executionKeys.object(object.objectId),
      );
      if (existing !== null) {
        if (existing.fingerprint !== object.contentHash) {
          throw new ExecutionStoreError(
            "immutable_object_conflict",
            `Execution object ${object.objectId} has another content hash`,
          );
        }
        return { objectId: decodeExecutionObject(existing.value).objectId };
      }
      const name = "execution-object";
      const outcome = yield* kernel.apply({
        ensures: [
          {
            name,
            collection: DurableCollections.executionObjects,
            key: executionKeys.object(object.objectId),
            fingerprint: object.contentHash,
            value: encodeExecutionObject(object),
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
      const record = yield* kernel.readImmutable(
        DurableCollections.executionObjects,
        executionKeys.object(pointer.objectId),
      );
      return record === null ? null : decodeExecutionObject(record.value);
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
