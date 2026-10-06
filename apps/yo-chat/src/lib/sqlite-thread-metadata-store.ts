import type Database from "better-sqlite3";
import { and, sql, desc, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { ThreadSummary } from "./threaded-chat-types";
import { ensureThreadMetadataSchema, threadMetadata } from "./thread-metadata-schema";
import {
  createThreadSummary,
  normalizeNamespace,
  threadListLimit,
  applyThreadMetadataUpdate,
  type SynchronousThreadMetadataStore,
} from "./thread-metadata-store";

/**
 * Durable thread metadata as a co-tenant table: rows live in yo-chat's own
 * `thread_metadata` table beside the kernel's reserved `sp_` namespace, on
 * the same binding the application hands to the kernel. Writes run on this
 * application connection per the co-tenant write discipline; authority
 * writes stay on the kernel's connection.
 */
export function createSqliteThreadMetadataStore(
  binding: Database.Database,
): SynchronousThreadMetadataStore {
  ensureThreadMetadataSchema(binding);
  const db: BetterSQLite3Database<{ threadMetadata: typeof threadMetadata }> = drizzle(binding, {
    schema: { threadMetadata },
  });

  const readRow = (row: typeof threadMetadata.$inferSelect): ThreadSummary => ({
    namespace: row.namespace,
    id: row.id,
    title: row.title,
    // The kernel-disciplined binding returns INTEGER columns as bigint.
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    lastMessagePreview: row.lastMessagePreview,
    messageCount: Number(row.messageCount),
  });

  const get = (threadId: string): ThreadSummary | null => {
    const row = db.select().from(threadMetadata).where(eq(threadMetadata.id, threadId)).get();
    return row ? readRow(row) : null;
  };

  return {
    list(namespace, options = {}) {
      const limit = threadListLimit(options);
      const rows = db
        .select()
        .from(threadMetadata)
        .where(
          and(
            namespace === undefined
              ? undefined
              : eq(threadMetadata.namespace, normalizeNamespace(namespace)),
            options.before
              ? sql`(${threadMetadata.updatedAt}, ${threadMetadata.id}) < (${options.before.updatedAt}, ${options.before.id})`
              : undefined,
          ),
        )
        .orderBy(desc(threadMetadata.updatedAt), desc(threadMetadata.id))
        .limit(limit)
        .all();
      return rows.map(readRow);
    },

    get,

    create(input = {}) {
      const thread = createThreadSummary(input);
      db.insert(threadMetadata)
        .values({
          id: thread.id,
          namespace: thread.namespace,
          title: thread.title,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          lastMessagePreview: thread.lastMessagePreview,
          messageCount: thread.messageCount,
        })
        .run();
      return thread;
    },

    update(threadId, input) {
      const existing = get(threadId);
      if (!existing) {
        return null;
      }
      const next = applyThreadMetadataUpdate(existing, input, Date.now());
      db.update(threadMetadata)
        .set({
          title: next.title,
          lastMessagePreview: next.lastMessagePreview,
          messageCount: next.messageCount,
          updatedAt: next.updatedAt,
        })
        .where(eq(threadMetadata.id, threadId))
        .run();
      return next;
    },

    delete(threadId) {
      const result = db.delete(threadMetadata).where(eq(threadMetadata.id, threadId)).run();
      return result.changes > 0;
    },
  };
}
