import { canonicalSnapshot } from "@sweatpants/foundation";
import type { Operation } from "effection";
import { ConversationStoreApi } from "@sweatpants/history-store/port";
import { ExecutionStoreApi } from "@sweatpants/journal-authority/api";

export interface StorageReadMetricsSnapshot {
  readonly headReads: number;
  readonly checkpointReads: number;
  readonly archivePageReads: number;
  readonly terminalHistoryPageReads: number;
  readonly peakMaterializedReplayBytes: number;
}

export interface StorageReadMetricsRecorder {
  metrics(): StorageReadMetricsSnapshot;
  reset(): void;
}

/**
 * Observation-only read middleware for storage evidence. It is deliberately
 * installed in an Effection scope rather than carried by a store contract or
 * repository instance.
 */
export function* installStorageReadMetrics(): Operation<StorageReadMetricsRecorder> {
  let headReads = 0;
  let checkpointReads = 0;
  let archivePageReads = 0;
  let terminalHistoryPageReads = 0;
  let peakMaterializedReplayBytes = 0;

  yield* ConversationStoreApi.around({
    *loadHead([conversationId], next) {
      headReads += 1;
      return yield* next(conversationId);
    },
    *getCheckpoint([pointer], next) {
      checkpointReads += 1;
      return yield* next(pointer);
    },
    *readPublicArchivePage([conversationId, cursor, limit], next) {
      archivePageReads += 1;
      return yield* next(conversationId, cursor, limit);
    },
    *readTerminalHistoryPage([conversationId, cursor, limit], next) {
      terminalHistoryPageReads += 1;
      return yield* next(conversationId, cursor, limit);
    },
  });

  yield* ExecutionStoreApi.around({
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
        archivePageReads,
        terminalHistoryPageReads,
        peakMaterializedReplayBytes,
      };
    },
    reset(): void {
      headReads = 0;
      checkpointReads = 0;
      archivePageReads = 0;
      terminalHistoryPageReads = 0;
      peakMaterializedReplayBytes = 0;
    },
  };
}
