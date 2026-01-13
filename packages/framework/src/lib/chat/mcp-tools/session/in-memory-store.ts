/**
 * In-Memory Tool Session Store
 *
 * Simple Map-based implementation of ToolSessionStore for development
 * and single-process deployments.
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type {
  ToolSessionStore,
  ToolSessionEntry,
  ToolSessionStatus,
} from './types.ts'

/**
 * Create an in-memory tool session store.
 *
 * This store is suitable for:
 * - Development and testing
 * - Single-process deployments
 * - Serverless functions with no durability requirements
 *
 * For production with durability, use Redis or Durable Objects stores.
 *
 * @example
 * ```typescript
 * const store = createInMemoryToolSessionStore()
 *
 * yield* setupToolSessions({
 *   store,
 *   samplingProvider: myProvider,
 * })
 * ```
 */
export function createInMemoryToolSessionStore(): ToolSessionStore {
  const entries = new Map<string, ToolSessionEntry>()

  return {
    *get(sessionId: string): Operation<ToolSessionEntry | null> {
      return entries.get(sessionId) ?? null
    },

    *set(sessionId: string, entry: ToolSessionEntry): Operation<void> {
      entries.set(sessionId, entry)
    },

    *delete(sessionId: string): Operation<void> {
      entries.delete(sessionId)
    },

    *updateRefCount(sessionId: string, delta: number): Operation<number> {
      const entry = entries.get(sessionId)
      if (!entry) {
        throw new Error(`Session ${sessionId} not found in store`)
      }
      entry.refCount += delta
      return entry.refCount
    },

    *updateStatus(sessionId: string, status: ToolSessionStatus): Operation<void> {
      const entry = entries.get(sessionId)
      if (!entry) {
        throw new Error(`Session ${sessionId} not found in store`)
      }
      entry.status = status
    },
  }
}

/**
 * Create an in-memory store with additional debugging helpers.
 * Useful for testing.
 */
export function createInMemoryToolSessionStoreWithDebug(): ToolSessionStore & {
  /** Get all session IDs */
  getSessionIds(): string[]
  /** Get entry count */
  getCount(): number
  /** Clear all entries */
  clear(): void
} {
  const entries = new Map<string, ToolSessionEntry>()

  const store: ToolSessionStore = {
    *get(sessionId: string): Operation<ToolSessionEntry | null> {
      return entries.get(sessionId) ?? null
    },

    *set(sessionId: string, entry: ToolSessionEntry): Operation<void> {
      entries.set(sessionId, entry)
    },

    *delete(sessionId: string): Operation<void> {
      entries.delete(sessionId)
    },

    *updateRefCount(sessionId: string, delta: number): Operation<number> {
      const entry = entries.get(sessionId)
      if (!entry) {
        throw new Error(`Session ${sessionId} not found in store`)
      }
      entry.refCount += delta
      return entry.refCount
    },

    *updateStatus(sessionId: string, status: ToolSessionStatus): Operation<void> {
      const entry = entries.get(sessionId)
      if (!entry) {
        throw new Error(`Session ${sessionId} not found in store`)
      }
      entry.status = status
    },
  }

  return {
    ...store,
    getSessionIds() {
      return Array.from(entries.keys())
    },
    getCount() {
      return entries.size
    },
    clear() {
      entries.clear()
    },
  }
}
