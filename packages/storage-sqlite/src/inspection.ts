import { sql } from "drizzle-orm";
import type { StorageReadMetricsSnapshot } from "./metrics.ts";
import type { SweatpantsSqliteDatabase } from "./repository.ts";

export interface StorageTableReport {
  readonly rows: number;
  readonly encodedBytes: number;
}

export interface TaskStorageReport {
  readonly executionId: string;
  readonly taskId: string;
  readonly rows: number;
  readonly encodedBytes: number;
}

export interface StorageReport {
  readonly tables: Readonly<Record<string, StorageTableReport>>;
  readonly journalByTask: readonly TaskStorageReport[];
  readonly replayByTask: readonly TaskStorageReport[];
  readonly checkpointWriteBytes: number;
  readonly runtimeMetricsCaptured: boolean;
  readonly hydrationReads: number;
  readonly hydrationReadBytes: number;
  readonly archivePageReads: number;
  readonly publicHistoryIndexRows: number;
  readonly publicHistorySegmentReads: number;
  readonly publicHistorySegmentReadBytes: number;
  readonly peakPublicHistoryPageBytes: number;
  readonly preparedContextReads: number;
  readonly preparedContextReadBytes: number;
  readonly preparedContextObjectBytes: number;
  readonly totalRetainedArchiveBytes: number;
  readonly totalRetainedReplayBytes: number;
  readonly peakMaterializedReplayBytes: number;
}

interface AggregateRow {
  rows: number | bigint;
  encoded_bytes: number | bigint;
}

function safeNumber(value: number | bigint): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error("Inspection aggregate is outside the safe number range");
  }
  return normalized;
}

function aggregate(database: SweatpantsSqliteDatabase, table: string): StorageTableReport {
  const row = database.get(
    sql.raw(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(encoded_bytes), 0) AS encoded_bytes FROM ${table}`,
    ),
  ) as AggregateRow;
  return { rows: safeNumber(row.rows), encodedBytes: safeNumber(row.encoded_bytes) };
}

function expressionAggregate(
  database: SweatpantsSqliteDatabase,
  table: string,
  expression: string,
): StorageTableReport {
  const row = database.get(
    sql.raw(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(${expression}), 0) AS encoded_bytes FROM ${table}`,
    ),
  ) as AggregateRow;
  return { rows: safeNumber(row.rows), encodedBytes: safeNumber(row.encoded_bytes) };
}

function taskAggregates(
  database: SweatpantsSqliteDatabase,
  table: string,
): readonly TaskStorageReport[] {
  const rows = database.all(
    sql.raw(
      `SELECT execution_id, task_id, COUNT(*) AS rows, COALESCE(SUM(encoded_bytes), 0) AS encoded_bytes
       FROM ${table} GROUP BY execution_id, task_id ORDER BY execution_id, task_id`,
    ),
  ) as Array<{
    execution_id: string;
    task_id: string;
    rows: number | bigint;
    encoded_bytes: number | bigint;
  }>;
  return rows.map((row) => ({
    executionId: row.execution_id,
    taskId: row.task_id,
    rows: safeNumber(row.rows),
    encodedBytes: safeNumber(row.encoded_bytes),
  }));
}

/**
 * Offline physical storage evidence. Exact totals deliberately scan the database;
 * never call this from chat requests or a D1 billing-sensitive polling loop.
 */
export function readStorageReport(
  database: SweatpantsSqliteDatabase,
  metrics?: StorageReadMetricsSnapshot,
): StorageReport {
  const tables = {
    sp_conversation_heads: {
      rows: safeNumber(
        (
          database.get(sql`SELECT COUNT(*) AS rows FROM sp_conversation_heads`) as {
            rows: number | bigint;
          }
        ).rows,
      ),
      encodedBytes: 0,
    },
    sp_conversation_checkpoints: aggregate(database, "sp_conversation_checkpoints"),
    sp_conversation_public_segments: aggregate(database, "sp_conversation_public_segments"),
    sp_conversation_public_root_index: aggregate(database, "sp_conversation_public_root_index"),
    sp_conversation_terminal_segments: expressionAggregate(
      database,
      "sp_conversation_terminal_segments",
      "length(CAST(entries_json AS BLOB))",
    ),
    sp_conversation_command_receipts: {
      rows: safeNumber(
        (
          database.get(sql`SELECT COUNT(*) AS rows FROM sp_conversation_command_receipts`) as {
            rows: number | bigint;
          }
        ).rows,
      ),
      encodedBytes: 0,
    },
    sp_execution_control: expressionAggregate(
      database,
      "sp_execution_control",
      "length(CAST(control_json AS BLOB))",
    ),
    sp_execution_journal_segments: aggregate(database, "sp_execution_journal_segments"),
    sp_execution_replay_segments: aggregate(database, "sp_execution_replay_segments"),
    sp_execution_objects: expressionAggregate(database, "sp_execution_objects", "byte_length"),
  } satisfies Readonly<Record<string, StorageTableReport>>;
  const journalByTask = taskAggregates(database, "sp_execution_journal_segments");
  const replayByTask = taskAggregates(database, "sp_execution_replay_segments");
  const preparedContextObjects = database.get(
    sql`SELECT COUNT(*) AS rows, COALESCE(SUM(byte_length), 0) AS encoded_bytes
        FROM sp_execution_objects WHERE object_kind = 'prepared-model-context.v1'`,
  ) as AggregateRow;
  return {
    tables,
    journalByTask,
    replayByTask,
    checkpointWriteBytes: tables.sp_conversation_checkpoints.encodedBytes,
    runtimeMetricsCaptured: metrics !== undefined,
    hydrationReads: metrics ? safeNumber(metrics.headReads + metrics.checkpointReads) : 0,
    hydrationReadBytes: metrics ? safeNumber(metrics.checkpointReadBytes) : 0,
    archivePageReads: metrics ? safeNumber(metrics.archivePageReads) : 0,
    publicHistoryIndexRows: metrics ? safeNumber(metrics.publicHistoryIndexRows) : 0,
    publicHistorySegmentReads: metrics ? safeNumber(metrics.publicHistorySegmentReads) : 0,
    publicHistorySegmentReadBytes: metrics ? safeNumber(metrics.publicHistorySegmentReadBytes) : 0,
    peakPublicHistoryPageBytes: metrics ? safeNumber(metrics.peakPublicHistoryPageBytes) : 0,
    preparedContextReads: metrics ? safeNumber(metrics.preparedContextReads) : 0,
    preparedContextReadBytes: metrics ? safeNumber(metrics.preparedContextReadBytes) : 0,
    preparedContextObjectBytes: safeNumber(preparedContextObjects.encoded_bytes),
    totalRetainedArchiveBytes: tables.sp_conversation_public_segments.encodedBytes,
    totalRetainedReplayBytes: tables.sp_execution_replay_segments.encodedBytes,
    peakMaterializedReplayBytes: metrics ? safeNumber(metrics.peakMaterializedReplayBytes) : 0,
  };
}

/** Offline whole-database maintenance; visits checkpoints, with one indexed owner lookup each. */
export function cleanupCheckpointOrphans(
  database: SweatpantsSqliteDatabase,
  graceCutoff: number,
): number {
  const result = database.run(sql`DELETE FROM sp_conversation_checkpoints AS checkpoint
    WHERE checkpoint.created_at < ${graceCutoff}
      AND NOT EXISTS (
        SELECT 1 FROM sp_conversation_heads AS head
        WHERE head.conversation_id = checkpoint.conversation_id
          AND head.checkpoint_id = checkpoint.checkpoint_id
      )`);
  const changes = (result as { changes: number | bigint }).changes;
  return safeNumber(changes);
}

export const inspectionSql = Object.freeze({
  currentHead: `SELECT conversation_id, revision, owner_epoch, state,
       checkpoint_id, terminal_segment_id,
       active_execution_id, latest_completed_execution_id
FROM sp_conversation_heads WHERE conversation_id = ?`,
  checkpoints: `SELECT checkpoint_id, cause_key, content_hash,
       archive_head_segment_id, archive_frontier_ordinal, next_public_position,
       encoded_bytes, created_at
FROM sp_conversation_checkpoints
WHERE conversation_id = ? ORDER BY created_at, checkpoint_id`,
  publicArchive: `SELECT segment_id, previous_segment_id, min_position, max_position,
       encoded_bytes, content_hash
FROM sp_conversation_public_segments
WHERE conversation_id = ? ORDER BY min_position, segment_id`,
  terminalHistory: `SELECT segment_id, previous_segment_id, first_position, last_position,
       content_hash, created_at
FROM sp_conversation_terminal_segments
WHERE conversation_id = ? ORDER BY first_position, segment_id`,
  commandReceipts: `SELECT conversation_id, command_id, command_digest,
       participant_id, admitted_revision, resulting_revision, accepted_at, retain_until
FROM sp_conversation_command_receipts
WHERE conversation_id = ? ORDER BY command_id`,
  executionControl: `SELECT execution_id, control_revision, owner_fence, status,
       root_task_id, stop_generation, requested_disposition, updated_at
FROM sp_execution_control WHERE execution_id = ?`,
  journalRanges: `SELECT execution_id, task_id, first_sequence, last_sequence,
       encoded_bytes, content_hash
FROM sp_execution_journal_segments
WHERE execution_id = ? ORDER BY task_id, first_sequence`,
  replayRanges: `SELECT execution_id, task_id, first_sequence, last_sequence,
       encoded_bytes, content_hash
FROM sp_execution_replay_segments
WHERE execution_id = ? ORDER BY task_id, first_sequence`,
  objectScopes: `SELECT object_id, lifetime_scope, scope_owner_id, object_kind,
       byte_length, content_hash
FROM sp_execution_objects
WHERE scope_owner_id = ? ORDER BY object_kind, object_id`,
  checkpointOrphans: `SELECT checkpoint_id, conversation_id, created_at
FROM sp_conversation_checkpoints AS checkpoint
WHERE checkpoint.created_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM sp_conversation_heads AS head
    WHERE head.conversation_id = checkpoint.conversation_id
          AND head.checkpoint_id = checkpoint.checkpoint_id
  )`,
  cleanupCheckpointOrphans: `DELETE FROM sp_conversation_checkpoints AS checkpoint
WHERE checkpoint.created_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM sp_conversation_heads AS head
    WHERE head.conversation_id = checkpoint.conversation_id
          AND head.checkpoint_id = checkpoint.checkpoint_id
  )`,
});
