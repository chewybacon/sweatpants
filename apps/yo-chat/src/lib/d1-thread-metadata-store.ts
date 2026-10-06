import type { D1Database } from "@cloudflare/workers-types";
import {
  createThreadSummary,
  normalizeNamespace,
  threadListLimit,
  type ThreadMetadataStore,
} from "./thread-metadata-store";
import type { ThreadSummary } from "./threaded-chat-types";

const columns = `id, namespace, title, created_at AS createdAt, updated_at AS updatedAt,
  last_message_preview AS lastMessagePreview, message_count AS messageCount`;

/** App metadata only. This binding is not the durable journal authority. */
export function createD1ThreadMetadataStore(database: D1Database): ThreadMetadataStore {
  // Every operation begins at the primary; callers need not transport read bookmarks.
  const session = () => database.withSession("first-primary");
  return {
    async list(namespace, options = {}) {
      const limit = threadListLimit(options);
      const clauses: string[] = [];
      const args: (string | number)[] = [];
      if (namespace !== undefined) {
        clauses.push("namespace = ?");
        args.push(normalizeNamespace(namespace));
      }
      if (options.before) {
        clauses.push("(updated_at, id) < (?, ?)");
        args.push(options.before.updatedAt, options.before.id);
      }
      const result = await session()
        .prepare(`SELECT ${columns} FROM thread_metadata
        ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .bind(...args, limit)
        .all<ThreadSummary>();
      return result.results;
    },
    async get(id) {
      return session()
        .prepare(`SELECT ${columns} FROM thread_metadata WHERE id = ?`)
        .bind(id)
        .first<ThreadSummary>();
    },
    async create(input = {}) {
      const thread = createThreadSummary(input);
      await session()
        .prepare(`INSERT INTO thread_metadata
        (id, namespace, title, created_at, updated_at, last_message_preview, message_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          thread.id,
          thread.namespace,
          thread.title,
          thread.createdAt,
          thread.updatedAt,
          thread.lastMessagePreview,
          thread.messageCount,
        )
        .run();
      return thread;
    },
    async update(id, input) {
      const normalized = createThreadSummary(input);
      // One statement preserves concurrent updates to fields omitted by this caller.
      return session()
        .prepare(`UPDATE thread_metadata SET
        title = COALESCE(?, title), last_message_preview = COALESCE(?, last_message_preview),
        message_count = COALESCE(?, message_count), updated_at = ?
        WHERE id = ? RETURNING ${columns}`)
        .bind(
          input.title === undefined ? null : normalized.title,
          input.lastMessagePreview === undefined ? null : normalized.lastMessagePreview,
          input.messageCount === undefined ? null : normalized.messageCount,
          normalized.updatedAt,
          id,
        )
        .first<ThreadSummary>();
    },
    async delete(id) {
      const result = await session()
        .prepare("DELETE FROM thread_metadata WHERE id = ?")
        .bind(id)
        .run();
      return result.meta.changes > 0;
    },
  };
}
