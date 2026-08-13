import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { run } from "effection";
import { sql } from "drizzle-orm";
import {
  openBetterSqliteStorage,
  type BetterSqliteStorageHandle,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { readStorageReport, type StorageReport } from "@sweatpants/storage-sqlite/inspection";

export interface StorageInspectorApi {
  handle(request: IncomingMessage, response: ServerResponse, next: () => void): void;
  close(): Promise<void>;
}

interface StorageDatabaseRow {
  readonly [key: string]: unknown;
}

const defaultDatabasePath = resolve(
  process.env["SWEATPANTS_STORAGE_SPINE_PATH"] ??
    resolve(process.cwd(), ".tmp/storage-spine/spine.sqlite"),
);

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  }
  return value;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(jsonSafe(value)));
}

function rawRows(
  handle: BetterSqliteStorageHandle,
  statement: string,
): readonly StorageDatabaseRow[] {
  return handle.database.all(sql.raw(statement)) as StorageDatabaseRow[];
}

function rawRow(
  handle: BetterSqliteStorageHandle,
  statement: string,
): StorageDatabaseRow | undefined {
  return handle.database.get(sql.raw(statement)) as StorageDatabaseRow | undefined;
}

function publicHead(handle: BetterSqliteStorageHandle): unknown {
  return rawRow(handle, "PRAGMA journal_mode");
}

function summary(handle: BetterSqliteStorageHandle, databasePath: string): unknown {
  const report: StorageReport = readStorageReport(handle.database);
  const heads = rawRows(
    handle,
    `SELECT conversation_id, revision, owner_epoch, state,
            checkpoint_id, terminal_segment_id,
            active_logical_turn_id, active_execution_id,
            latest_completed_execution_id, updated_at
     FROM sp_conversation_heads ORDER BY conversation_id`,
  );
  const executions = rawRows(
    handle,
    `SELECT execution_id, control_revision, owner_fence, status,
            root_task_id, stop_generation, requested_disposition, updated_at
     FROM sp_execution_control ORDER BY execution_id`,
  );
  return {
    databasePath,
    journalMode: publicHead(handle),
    report,
    heads,
    executions,
  };
}

function conversation(handle: BetterSqliteStorageHandle, conversationId: string): unknown {
  const heads = handle.database.all(
    sql`SELECT conversation_id, revision, owner_epoch, state,
               checkpoint_id, terminal_segment_id,
               active_logical_turn_id, active_execution_id,
               latest_completed_execution_id, deleted_at, updated_at
        FROM sp_conversation_heads WHERE conversation_id = ${conversationId}`,
  ) as StorageDatabaseRow[];
  const checkpoints = handle.database.all(
    sql`SELECT checkpoint_id, conversation_id, cause_key, content_hash,
               archive_head_segment_id, archive_through_position, encoded_bytes, created_at
        FROM sp_conversation_checkpoints
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at, checkpoint_id`,
  ) as StorageDatabaseRow[];
  const publicSegments = handle.database.all(
    sql`SELECT segment_id, conversation_id, previous_segment_id,
               first_position, last_position, content_hash, encoded_bytes, created_at
        FROM sp_conversation_public_segments
        WHERE conversation_id = ${conversationId}
        ORDER BY first_position, segment_id`,
  ) as StorageDatabaseRow[];
  const terminalSegments = handle.database.all(
    sql`SELECT segment_id, conversation_id, logical_turn_id, execution_id,
               publication_key, previous_segment_id, first_position, last_position,
               content_hash, created_at
        FROM sp_conversation_terminal_segments
        WHERE conversation_id = ${conversationId}
        ORDER BY first_position, segment_id`,
  ) as StorageDatabaseRow[];
  const receipts = handle.database.all(
    sql`SELECT conversation_id, command_id, command_digest, participant_id,
               admitted_revision, resulting_revision, accepted_at, retain_until,
               logical_turn_id, execution_id
        FROM sp_conversation_command_receipts
        WHERE conversation_id = ${conversationId}
        ORDER BY command_id`,
  ) as StorageDatabaseRow[];
  return {
    conversationId,
    head: heads[0] ?? null,
    checkpoints,
    publicSegments,
    terminalSegments,
    commandReceipts: receipts,
    bodies: "redacted",
  };
}

function execution(handle: BetterSqliteStorageHandle, executionId: string): unknown {
  const control = handle.database.all(
    sql`SELECT execution_id, control_revision, owner_fence, status,
               root_task_id, stop_generation, requested_disposition, updated_at
        FROM sp_execution_control
        WHERE execution_id = ${executionId}`,
  ) as StorageDatabaseRow[];
  const journal = handle.database.all(
    sql`SELECT segment_id, execution_id, task_id, previous_segment_id,
               first_sequence, last_sequence, content_hash, encoded_bytes, created_at
        FROM sp_execution_journal_segments
        WHERE execution_id = ${executionId}
        ORDER BY task_id, first_sequence`,
  ) as StorageDatabaseRow[];
  const replay = handle.database.all(
    sql`SELECT segment_id, execution_id, task_id, previous_segment_id,
               first_sequence, last_sequence, content_hash, encoded_bytes, created_at
        FROM sp_execution_replay_segments
        WHERE execution_id = ${executionId}
        ORDER BY task_id, first_sequence`,
  ) as StorageDatabaseRow[];
  const objects = handle.database.all(
    sql`SELECT object_id, lifetime_scope, scope_owner_id, object_kind,
               content_hash, byte_length, created_at,
               CASE WHEN json_body IS NULL THEN 'blob' ELSE 'json' END AS body_kind
        FROM sp_execution_objects
        WHERE scope_owner_id = ${executionId}
        ORDER BY object_kind, object_id`,
  ) as StorageDatabaseRow[];
  return {
    executionId,
    control,
    journal,
    replay,
    objects,
    bodies: "redacted",
  };
}

export async function createStorageInspectorApi(
  databasePath = defaultDatabasePath,
): Promise<StorageInspectorApi> {
  let handle: BetterSqliteStorageHandle | undefined;
  let openError: unknown;

  if (existsSync(databasePath)) {
    try {
      handle = await run(() =>
        openBetterSqliteStorage(databasePath, { migrate: false, wal: true }),
      );
    } catch (error) {
      openError = error;
    }
  }

  return {
    handle(request, response, next) {
      const pathname = new URL(request.url ?? "/", "http://storage-inspector").pathname;
      if (!pathname.startsWith("/api/storage")) {
        next();
        return;
      }
      if (request.method !== "GET") {
        send(response, 405, { error: "Storage inspector is read-only" });
        return;
      }
      if (!handle) {
        send(response, 404, {
          error: openError
            ? `Unable to open SQLite database: ${openError instanceof Error ? openError.message : String(openError)}`
            : "SQLite database does not exist",
          databasePath,
        });
        return;
      }
      try {
        const parts = pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
        if (parts.length === 0 || parts[0] === "summary") {
          send(response, 200, summary(handle, databasePath));
          return;
        }
        if (parts[0] === "conversations" && parts[1]) {
          send(response, 200, conversation(handle, parts.slice(1).join("/")));
          return;
        }
        if (parts[0] === "executions" && parts[1]) {
          send(response, 200, execution(handle, parts.slice(1).join("/")));
          return;
        }
        send(response, 404, { error: "Unknown storage inspector endpoint" });
      } catch (error) {
        send(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async close() {
      if (handle) {
        await run(() => handle!.close());
      }
      handle = undefined;
    },
  };
}
