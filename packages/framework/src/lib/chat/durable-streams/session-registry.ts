/**
 * Session Registry Implementation
 *
 * Manages session lifecycle with reference counting for automatic cleanup.
 * Sessions represent the duration of a single LLM request, not the entire
 * chat conversation.
 *
 * Key behaviors:
 * - acquire() creates or returns existing session, increments refCount
 * - release() decrements refCount, triggers cleanup when refCount=0 AND complete
 * - LLM writer tasks run in the registry's scope, surviving client disconnects
 * - Reconnection works by acquiring the same sessionId while LLM is still streaming
 */
import { spawn, sleep } from 'effection'
import type { Operation } from 'effection'
import type {
  TokenBufferStore,
  SessionRegistry,
  SessionRegistryStore,
  SessionEntry,
  SessionHandle,
  SessionStatus,
  CreateSessionOptions,
} from './types'
import { writeFromStreamToBuffer } from './pull-stream'

/**
 * Internal mutable state for tracking session status.
 * Updated by the writer task, read by the status() method.
 */
interface MutableSessionState {
  status: SessionStatus
}

/**
 * Creates a SessionRegistry for managing session lifecycles.
 *
 * The registry must be created as an Operation so that spawned writer tasks
 * run in the registry's scope (typically the server scope), not individual
 * request scopes.
 *
 * @param bufferStore - Store for creating and managing TokenBuffers
 * @param registryStore - Store for tracking session entries and refCounts
 * @returns SessionRegistry
 *
 * @example
 * ```typescript
 * // At server startup
 * const bufferStore = createInMemoryBufferStore()
 * const registryStore = createInMemoryRegistryStore()
 * const registry = yield* createSessionRegistry(bufferStore, registryStore)
 *
 * // In request handler
 * const session = yield* registry.acquire(sessionId, { source: llmStream })
 * yield* ensure(() => registry.release(sessionId))
 * // ... use session.buffer ...
 * ```
 */
export function* createSessionRegistry<T>(
  bufferStore: TokenBufferStore<T>,
  registryStore: SessionRegistryStore<T>
): Operation<SessionRegistry<T>> {
  // Track mutable state for each session (status updates from writer tasks)
  const sessionStates = new Map<string, MutableSessionState>()

  const registry: SessionRegistry<T> = {
    *acquire(
      sessionId: string,
      options?: CreateSessionOptions<T>
    ): Operation<SessionHandle<T>> {
      // Check if session already exists
      const existing = yield* registryStore.get(sessionId)

      if (existing) {
        // Increment refCount and return existing handle
        yield* registryStore.updateRefCount(sessionId, 1)
        return existing.handle
      }

      // Create new session - requires source stream
      if (!options?.source) {
        throw new Error('Session not found and no source provided')
      }

      // Create buffer for this session
      const buffer = yield* bufferStore.create(sessionId)

      // Create mutable state object (shared reference for status updates)
      const state: MutableSessionState = { status: 'streaming' }
      sessionStates.set(sessionId, state)

      // Create handle that reads status from mutable state
      const handle: SessionHandle<T> = {
        id: sessionId,
        buffer,
        *status(): Operation<SessionStatus> {
          return state.status
        },
      }

      // Spawn writer task - runs in THIS scope (registry's scope)
      // This is key: the writer outlives individual request scopes
      const source = options.source
      yield* spawn(function* () {
        try {
          yield* writeFromStreamToBuffer(source, buffer)
          state.status = 'complete'
        } catch (err) {
          state.status = 'error'
          yield* buffer.fail(err as Error)
        }
      })

      // Store session entry with initial refCount of 1
      const entry: SessionEntry<T> = {
        handle,
        refCount: 1,
        createdAt: Date.now(),
      }
      yield* registryStore.set(sessionId, entry)

      return handle
    },

    *release(sessionId: string): Operation<void> {
      const entry = yield* registryStore.get(sessionId)
      if (!entry) return

      // Decrement refCount
      const newRefCount = yield* registryStore.updateRefCount(sessionId, -1)

      if (newRefCount === 0) {
        const currentStatus = yield* entry.handle.status()

        if (currentStatus === 'complete' || currentStatus === 'error') {
          // Session is done and no clients - cleanup immediately
          yield* registryStore.delete(sessionId)
          yield* bufferStore.delete(sessionId)
          sessionStates.delete(sessionId)
        } else {
          // Still streaming - spawn cleanup waiter
          // This handles the case where client disconnects but LLM is still writing
          yield* spawn(function* () {
            // Poll for completion
            while (true) {
              const s = yield* entry.handle.status()
              if (s === 'complete' || s === 'error') break
              yield* sleep(10)
            }

            // Re-check refCount (client might have reconnected)
            const currentEntry = yield* registryStore.get(sessionId)
            if (currentEntry && currentEntry.refCount === 0) {
              yield* registryStore.delete(sessionId)
              yield* bufferStore.delete(sessionId)
              sessionStates.delete(sessionId)
            }
          })
        }
      }
    },
  }

  return registry
}
