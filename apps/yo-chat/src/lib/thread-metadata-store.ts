import type Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { ThreadSummary } from "@/lib/threaded-chat-types";
import { ensureThreadMetadataSchema, threadMetadata } from "@/lib/thread-metadata-schema";

export interface CreateThreadMetadataInput {
  namespace?: string;
  id?: string;
  title?: string;
  lastMessagePreview?: string;
  messageCount?: number;
}

export interface UpdateThreadMetadataInput {
  title?: string;
  lastMessagePreview?: string;
  messageCount?: number;
}

export interface ThreadMetadataStore {
  list(namespace?: string): ThreadSummary[];
  get(threadId: string): ThreadSummary | null;
  create(input?: CreateThreadMetadataInput): ThreadSummary;
  update(threadId: string, input: UpdateThreadMetadataInput): ThreadSummary | null;
  delete(threadId: string): boolean;
}

function normalizeNamespace(namespace: string | undefined): string {
  const value = compact(namespace ?? "");
  return value || "default";
}

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTitle(title: string | undefined): string {
  const value = compact(title ?? "") || "New thread";
  return value.length > 40 ? `${value.slice(0, 37)}...` : value;
}

function normalizePreview(preview: string | undefined): string {
  const value = compact(preview ?? "") || "No messages yet";
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function normalizeMessageCount(messageCount: number | undefined): number {
  if (typeof messageCount !== "number" || Number.isNaN(messageCount) || messageCount < 0) {
    return 0;
  }

  return Math.floor(messageCount);
}

export function createThreadSummary(
  input: CreateThreadMetadataInput = {},
  now: number = Date.now(),
): ThreadSummary {
  return {
    namespace: normalizeNamespace(input.namespace),
    id: input.id ?? crypto.randomUUID(),
    title: normalizeTitle(input.title),
    createdAt: now,
    updatedAt: now,
    lastMessagePreview: normalizePreview(input.lastMessagePreview),
    messageCount: normalizeMessageCount(input.messageCount),
  };
}

function applyUpdate(
  existing: ThreadSummary,
  input: UpdateThreadMetadataInput,
  updatedAt: number,
): ThreadSummary {
  return {
    ...existing,
    title: input.title !== undefined ? normalizeTitle(input.title) : existing.title,
    lastMessagePreview:
      input.lastMessagePreview !== undefined
        ? normalizePreview(input.lastMessagePreview)
        : existing.lastMessagePreview,
    messageCount:
      input.messageCount !== undefined
        ? normalizeMessageCount(input.messageCount)
        : existing.messageCount,
    updatedAt,
  };
}

/**
 * Memory-mode thread metadata. Used only when the storage selection is
 * `SWEATPANTS_STORAGE=memory`; durable selections use the co-tenant store.
 */
export function createInMemoryThreadMetadataStore(): ThreadMetadataStore {
  const threads = new Map<string, ThreadSummary>();

  return {
    list(namespace) {
      return Array.from(threads.values())
        .filter((thread) => namespace === undefined || thread.namespace === namespace)
        .sort((left, right) => right.updatedAt - left.updatedAt);
    },

    get(threadId) {
      return threads.get(threadId) ?? null;
    },

    create(input = {}) {
      const thread = createThreadSummary(input);
      threads.set(thread.id, thread);
      return thread;
    },

    update(threadId, input) {
      const existing = threads.get(threadId);
      if (!existing) {
        return null;
      }
      const next = applyUpdate(existing, input, Date.now());
      threads.set(threadId, next);
      return next;
    },

    delete(threadId) {
      return threads.delete(threadId);
    },
  };
}

/**
 * Durable thread metadata as a co-tenant table: rows live in yo-chat's own
 * `thread_metadata` table beside the kernel's reserved `sp_` namespace, on
 * the same binding the application hands to the kernel. Writes run on this
 * application connection per the co-tenant write discipline; authority
 * writes stay on the kernel's connection.
 */
export function createSqliteThreadMetadataStore(binding: Database.Database): ThreadMetadataStore {
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
    list(namespace) {
      const rows = db
        .select()
        .from(threadMetadata)
        .where(
          namespace === undefined
            ? undefined
            : eq(threadMetadata.namespace, normalizeNamespace(namespace)),
        )
        .orderBy(desc(threadMetadata.updatedAt))
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
      const next = applyUpdate(existing, input, Date.now());
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

let sharedThreadMetadataStore: ThreadMetadataStore | null = null;

/**
 * Configures the process-wide thread metadata store once per storage
 * selection at composition time: sqlite selections get the durable
 * co-tenant store, memory selections the in-memory store.
 */
export function configureThreadMetadataStore(store: ThreadMetadataStore): void {
  sharedThreadMetadataStore = store;
}

export function getThreadMetadataStore(): ThreadMetadataStore {
  if (!sharedThreadMetadataStore) {
    throw new Error(
      "Thread metadata storage is not configured; compose yo-chat through createYoChatApplication",
    );
  }
  return sharedThreadMetadataStore;
}
