/**
 * In-Memory Store Implementations
 *
 * Provides in-memory implementations of TokenBufferStore and SessionRegistryStore
 * for development and single-server deployments.
 *
 * For production multi-server deployments, implement these interfaces
 * with Redis, Postgres, or other shared storage backends.
 */
import { createSignal, each } from 'effection'
import type { Operation, Signal } from 'effection'
import type {
  TokenBuffer,
  TokenBufferStore,
  SessionRegistryStore,
  SessionEntry,
} from './types.ts'

// =============================================================================
// IN-MEMORY TOKEN BUFFER
// =============================================================================

/**
 * Creates an in-memory TokenBuffer.
 *
 * Uses Effection Signal for change notification, allowing readers
 * to efficiently wait for new tokens without polling.
 */
export function createInMemoryBuffer<T>(id: string): TokenBuffer<T> {
  const tokens: T[] = []
  let completed = false
  let error: Error | null = null
  const changeSignal: Signal<void, void> = createSignal<void, void>()

  const buffer: TokenBuffer<T> = {
    id,

    *append(newTokens: T[]): Operation<number> {
      if (completed || error) {
        throw new Error('Buffer is closed')
      }
      tokens.push(...newTokens)
      changeSignal.send()
      return tokens.length
    },

    *complete(): Operation<void> {
      completed = true
      changeSignal.send()
    },

    *fail(err: Error): Operation<void> {
      error = err
      changeSignal.send()
    },

    *read(afterLSN = 0): Operation<{ tokens: T[]; lsn: number }> {
      return {
        tokens: tokens.slice(afterLSN),
        lsn: tokens.length,
      }
    },

    *isComplete(): Operation<boolean> {
      return completed
    },

    *getError(): Operation<Error | null> {
      return error
    },

    *waitForChange(afterLSN: number): Operation<void> {
      // If there's already new data or stream is done, return immediately
      if (tokens.length > afterLSN || completed || error) {
        return
      }
      // Wait for next change signal
      for (const _ of yield* each(changeSignal)) {
        break
      }
    },
  }

  return buffer
}

// =============================================================================
// IN-MEMORY TOKEN BUFFER STORE
// =============================================================================

/**
 * Creates an in-memory TokenBufferStore.
 *
 * Manages creation, lookup, and deletion of TokenBuffers using a Map.
 */
export function createInMemoryBufferStore<T>(): TokenBufferStore<T> {
  const buffers = new Map<string, TokenBuffer<T>>()

  return {
    *create(id: string): Operation<TokenBuffer<T>> {
      if (buffers.has(id)) {
        throw new Error(`Buffer ${id} already exists`)
      }
      const buffer = createInMemoryBuffer<T>(id)
      buffers.set(id, buffer)
      return buffer
    },

    *get(id: string): Operation<TokenBuffer<T> | null> {
      return buffers.get(id) ?? null
    },

    *delete(id: string): Operation<void> {
      buffers.delete(id)
    },
  }
}

// =============================================================================
// IN-MEMORY SESSION REGISTRY STORE
// =============================================================================

/**
 * Creates an in-memory SessionRegistryStore.
 *
 * Tracks session entries with refCount for lifecycle management.
 */
export function createInMemoryRegistryStore<T>(): SessionRegistryStore<T> {
  const entries = new Map<string, SessionEntry<T>>()

  return {
    *get(sessionId: string): Operation<SessionEntry<T> | null> {
      return entries.get(sessionId) ?? null
    },

    *set(sessionId: string, entry: SessionEntry<T>): Operation<void> {
      entries.set(sessionId, entry)
    },

    *delete(sessionId: string): Operation<void> {
      entries.delete(sessionId)
    },

    *updateRefCount(sessionId: string, delta: number): Operation<number> {
      const entry = entries.get(sessionId)
      if (!entry) {
        throw new Error(`Session ${sessionId} not found`)
      }
      entry.refCount += delta
      return entry.refCount
    },
  }
}
