import { Pool } from "pg";
import {
  createThreadSummary,
  threadListLimit,
  type ThreadMetadataStore,
} from "./thread-metadata-store";
import type { ThreadSummary } from "./threaded-chat-types";

const columns = `id, namespace, title, created_at AS "createdAt", updated_at AS "updatedAt",
  last_message_preview AS "lastMessagePreview", message_count AS "messageCount"`;

type ThreadRow = Omit<ThreadSummary, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};
function summary(row: ThreadRow): ThreadSummary {
  return { ...row, createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt) };
}

/** App-owned metadata lives beside the Postgres authority tables, outside their sp_ namespace. */
export function createPostgresThreadMetadataStore(connectionString: string): ThreadMetadataStore {
  const pool = new Pool({ connectionString, max: 2, allowExitOnIdle: true });
  let ready: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const ensureSchema = () =>
    (ready ??= pool.query(`
    CREATE TABLE IF NOT EXISTS thread_metadata (
      id text PRIMARY KEY, namespace text NOT NULL, title text NOT NULL,
      created_at bigint NOT NULL, updated_at bigint NOT NULL,
      last_message_preview text NOT NULL, message_count integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS thread_metadata_namespace_updated
      ON thread_metadata(namespace, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS thread_metadata_updated_id ON thread_metadata(updated_at DESC, id DESC);
  `));
  return {
    async list(namespace, options = {}) {
      const limit = threadListLimit(options);
      await ensureSchema();
      const args: (string | number)[] = [];
      const clauses: string[] = [];
      if (namespace !== undefined) {
        args.push(createThreadSummary({ namespace }).namespace);
        clauses.push(`namespace = $${args.length}`);
      }
      if (options.before) {
        args.push(options.before.updatedAt, options.before.id);
        clauses.push(`(updated_at, id) < ($${args.length - 1}, $${args.length})`);
      }
      args.push(limit);
      const result = await pool.query<ThreadRow>(
        `SELECT ${columns} FROM thread_metadata ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT $${args.length}`,
        args,
      );
      return result.rows.map(summary);
    },
    async get(id) {
      await ensureSchema();
      const result = await pool.query<ThreadRow>(
        `SELECT ${columns} FROM thread_metadata WHERE id = $1`,
        [id],
      );
      return result.rows[0] ? summary(result.rows[0]) : null;
    },
    async create(input = {}) {
      await ensureSchema();
      const thread = createThreadSummary(input);
      await pool.query(
        `INSERT INTO thread_metadata
        (id, namespace, title, created_at, updated_at, last_message_preview, message_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          thread.id,
          thread.namespace,
          thread.title,
          thread.createdAt,
          thread.updatedAt,
          thread.lastMessagePreview,
          thread.messageCount,
        ],
      );
      return thread;
    },
    async update(id, input) {
      await ensureSchema();
      const normalized = createThreadSummary(input);
      const result = await pool.query<ThreadRow>(
        `UPDATE thread_metadata SET
        title = COALESCE($2, title), last_message_preview = COALESCE($3, last_message_preview),
        message_count = COALESCE($4, message_count), updated_at = $5
        WHERE id = $1 RETURNING ${columns}`,
        [
          id,
          input.title === undefined ? null : normalized.title,
          input.lastMessagePreview === undefined ? null : normalized.lastMessagePreview,
          input.messageCount === undefined ? null : normalized.messageCount,
          normalized.updatedAt,
        ],
      );
      return result.rows[0] ? summary(result.rows[0]) : null;
    },
    async delete(id) {
      await ensureSchema();
      return (await pool.query("DELETE FROM thread_metadata WHERE id = $1", [id])).rowCount !== 0;
    },
    close: () => (closing ??= pool.end()),
  };
}
