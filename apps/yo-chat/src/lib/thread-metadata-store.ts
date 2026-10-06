import type { ThreadSummary } from "@/lib/threaded-chat-types";

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

export interface ThreadListCursor {
  updatedAt: number;
  id: string;
}
export interface ThreadListOptions {
  before?: ThreadListCursor;
  limit?: number;
}
export function threadListLimit(options: ThreadListOptions = {}): number {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Thread page limit must be between 1 and 100");
  return limit;
}

export interface SynchronousThreadMetadataStore {
  list(namespace?: string, options?: ThreadListOptions): ThreadSummary[];
  get(threadId: string): ThreadSummary | null;
  create(input?: CreateThreadMetadataInput): ThreadSummary;
  update(threadId: string, input: UpdateThreadMetadataInput): ThreadSummary | null;
  delete(threadId: string): boolean;
}

export type ThreadMetadataStore = {
  [K in keyof SynchronousThreadMetadataStore]: (
    ...args: Parameters<SynchronousThreadMetadataStore[K]>
  ) =>
    | ReturnType<SynchronousThreadMetadataStore[K]>
    | Promise<ReturnType<SynchronousThreadMetadataStore[K]>>;
} & { close?: () => Promise<void> };

export function normalizeNamespace(namespace: string | undefined): string {
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

export function applyThreadMetadataUpdate(
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
export function createInMemoryThreadMetadataStore(): SynchronousThreadMetadataStore {
  const threads = new Map<string, ThreadSummary>();

  return {
    list(namespace, options = {}) {
      const limit = threadListLimit(options);
      return Array.from(threads.values())
        .filter((thread) => namespace === undefined || thread.namespace === namespace)
        .filter(
          (thread) =>
            !options.before ||
            thread.updatedAt < options.before.updatedAt ||
            (thread.updatedAt === options.before.updatedAt && thread.id < options.before.id),
        )
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt ||
            (left.id < right.id ? 1 : left.id > right.id ? -1 : 0),
        )
        .slice(0, limit);
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
      const next = applyThreadMetadataUpdate(existing, input, Date.now());
      threads.set(threadId, next);
      return next;
    },

    delete(threadId) {
      return threads.delete(threadId);
    },
  };
}

let sharedThreadMetadataStore: ThreadMetadataStore | null = null;

/**
 * Configures the process-wide thread metadata store once per storage
 * selection at composition time. SQLite and Postgres use durable co-tenant
 * stores; only explicit memory mode uses the in-memory store.
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
