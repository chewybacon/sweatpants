import { canonicalSnapshot } from "@sweatpants/foundation";
import type { Operation } from "effection";
import {
  HistoryStoreReadObservationContext,
  type HistoryStoreReadObserver,
} from "@sweatpants/history-store";
import { ConversationStoreApi } from "@sweatpants/history-store/port";
import { ExecutionStoreApi } from "@sweatpants/journal-authority/api";

export interface StorageReadMetricsSnapshot {
  readonly headReads: number;
  readonly checkpointReads: number;
  readonly checkpointReadBytes: number;
  readonly archivePageReads: number;
  readonly publicHistoryIndexRows: number;
  readonly publicHistoryIndexBytes: number;
  readonly publicHistorySegmentReads: number;
  readonly publicHistorySegmentReadBytes: number;
  readonly peakPublicHistoryPageBytes: number;
  readonly preparedContextReads: number;
  readonly preparedContextReadBytes: number;
  readonly terminalHistoryPageReads: number;
  readonly peakMaterializedReplayBytes: number;
}

export interface StorageReadMetricsRecorder {
  metrics(): StorageReadMetricsSnapshot;
  reset(): void;
}

/**
 * Observation-only read middleware for storage evidence. It records numeric
 * counts and byte lengths only; payloads, tokens, and identifiers are excluded.
 */
export function* installStorageReadMetrics(): Operation<StorageReadMetricsRecorder> {
  let headReads = 0;
  let checkpointReads = 0;
  let checkpointReadBytes = 0;
  let archivePageReads = 0;
  let publicHistoryIndexRows = 0;
  let publicHistoryIndexBytes = 0;
  let publicHistorySegmentReads = 0;
  let publicHistorySegmentReadBytes = 0;
  let peakPublicHistoryPageBytes = 0;
  let preparedContextReads = 0;
  let preparedContextReadBytes = 0;
  let terminalHistoryPageReads = 0;
  let peakMaterializedReplayBytes = 0;

  const historyObservation: HistoryStoreReadObserver = {
    publicHistoryIndexPage(rows, storedBytes) {
      publicHistoryIndexRows += rows;
      publicHistoryIndexBytes += storedBytes;
    },
    publicHistorySegment(encodedBytes) {
      publicHistorySegmentReads += 1;
      publicHistorySegmentReadBytes += encodedBytes;
    },
    publicHistoryPageMaterialized(payloadBytes) {
      peakPublicHistoryPageBytes = Math.max(peakPublicHistoryPageBytes, payloadBytes);
    },
  };
  yield* HistoryStoreReadObservationContext.set(historyObservation);

  yield* ConversationStoreApi.around({
    *loadHead([conversationId], next) {
      headReads += 1;
      return yield* next(conversationId);
    },
    *getCheckpoint([pointer], next) {
      checkpointReads += 1;
      const checkpoint = yield* next(pointer);
      checkpointReadBytes += checkpoint?.encodedBytes ?? 0;
      return checkpoint;
    },
    *readPublicHistoryBefore([request], next) {
      archivePageReads += 1;
      return yield* next(request);
    },
    *readTerminalHistoryPage([conversationId, cursor, limit], next) {
      terminalHistoryPageReads += 1;
      return yield* next(conversationId, cursor, limit);
    },
  });

  yield* ExecutionStoreApi.around({
    *getObject([pointer], next) {
      const object = yield* next(pointer);
      if (object?.objectKind === "prepared-model-context.v1") {
        preparedContextReads += 1;
        preparedContextReadBytes += object.byteLength;
      }
      return object;
    },
    *readReplay([task], next) {
      const stream = yield* next(task);
      return (async function* () {
        for await (const entries of stream) {
          const encoded = canonicalSnapshot(entries);
          peakMaterializedReplayBytes = Math.max(
            peakMaterializedReplayBytes,
            new TextEncoder().encode(encoded.canonical).byteLength,
          );
          yield entries;
        }
      })();
    },
  });

  return {
    metrics(): StorageReadMetricsSnapshot {
      return {
        headReads,
        checkpointReads,
        checkpointReadBytes,
        archivePageReads,
        publicHistoryIndexRows,
        publicHistoryIndexBytes,
        publicHistorySegmentReads,
        publicHistorySegmentReadBytes,
        peakPublicHistoryPageBytes,
        preparedContextReads,
        preparedContextReadBytes,
        terminalHistoryPageReads,
        peakMaterializedReplayBytes,
      };
    },
    reset(): void {
      headReads = 0;
      checkpointReads = 0;
      checkpointReadBytes = 0;
      archivePageReads = 0;
      publicHistoryIndexRows = 0;
      publicHistoryIndexBytes = 0;
      publicHistorySegmentReads = 0;
      publicHistorySegmentReadBytes = 0;
      peakPublicHistoryPageBytes = 0;
      preparedContextReads = 0;
      preparedContextReadBytes = 0;
      terminalHistoryPageReads = 0;
      peakMaterializedReplayBytes = 0;
    },
  };
}
