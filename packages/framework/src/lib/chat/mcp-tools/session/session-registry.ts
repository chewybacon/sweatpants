/**
 * Tool Session Registry Implementation
 *
 * Manages tool session lifecycle with reference counting for automatic cleanup.
 * Sessions represent a durable tool execution that survives HTTP request boundaries.
 *
 * Key behaviors:
 * - create() creates a new session and starts tool execution
 * - acquire() returns existing session, increments refCount
 * - release() decrements refCount, triggers cleanup when refCount=0 AND complete
 * - Tool execution runs in background via spawn, surviving client disconnects
 * - Reconnection works by acquiring the same sessionId while tool is still running
 *
 * @packageDocumentation
 */
import { type Operation, spawn, resource, sleep } from 'effection'
import type {
  ToolSessionRegistry,
  ToolSessionStore,
  ToolSession,
  ToolSessionEntry,
  ToolSessionOptions,
  ToolSessionSamplingProvider,
  ToolSessionStatus,
} from './types'
import type { ElicitsMap } from '../mcp-tool-types'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder'
import { createToolSession } from './tool-session'

// =============================================================================
// SESSION REGISTRY IMPLEMENTATION
// =============================================================================

/**
 * Options for creating a tool session registry.
 */
export interface ToolSessionRegistryOptions {
  /**
   * Provider for LLM sampling when tools use ctx.sample().
   */
  samplingProvider: ToolSessionSamplingProvider

  /**
   * Default timeout for sessions in milliseconds.
   * @default undefined (no timeout)
   */
  defaultTimeout?: number
}

/**
 * Creates a ToolSessionRegistry for managing tool session lifecycles.
 *
 * The registry manages tool execution and provides reference counting
 * for automatic cleanup when sessions are no longer needed.
 *
 * @param store - Store for tracking session entries
 * @param options - Registry configuration options
 * @returns ToolSessionRegistry resource
 *
 * @example
 * ```typescript
 * // At server startup
 * const store = yield* createInMemoryToolSessionStore()
 * const registry = yield* createToolSessionRegistry(store, {
 *   samplingProvider: { sample: ... }
 * })
 *
 * // In request handler - create a new session
 * const session = yield* registry.create(tool, params)
 *
 * // Or acquire existing session for reconnection
 * const session = yield* registry.acquire(sessionId)
 *
 * // Always release when done
 * yield* registry.release(sessionId)
 * ```
 */
export function createToolSessionRegistry(
  store: ToolSessionStore,
  options: ToolSessionRegistryOptions
): Operation<ToolSessionRegistry> {
  return resource<ToolSessionRegistry>(function* (provide) {
    const { samplingProvider, defaultTimeout } = options

    // Track active session resources
    // (The actual ToolSession is an Effection resource, so we need to keep
    // track of them separately from the store entries)
    const activeSessions = new Map<string, ToolSession>()

    /**
     * Internal cleanup helper - removes session from store and active map.
     */
    function* cleanup(sessionId: string): Operation<void> {
      yield* store.delete(sessionId)
      activeSessions.delete(sessionId)
    }

    const registry: ToolSessionRegistry = {
      *create<TParams, THandoff, TClient, TResult, TElicits extends ElicitsMap>(
        tool: FinalizedMcpToolWithElicits<string, TParams, THandoff, TClient, TResult, TElicits>,
        params: TParams,
        sessionOptions?: ToolSessionOptions
      ): Operation<ToolSession<TResult>> {
        // Merge options with defaults - spread conditionally for exactOptionalPropertyTypes
        const mergedOptions: ToolSessionOptions = {
          ...sessionOptions,
          ...(defaultTimeout !== undefined && { timeout: defaultTimeout }),
        }

        // Create the session resource
        // The session is a resource that keeps the tool's generator alive
        const session = yield* createToolSession(
          tool,
          params,
          samplingProvider,
          mergedOptions
        )

        // Store in active sessions map
        activeSessions.set(session.id, session as ToolSession)

        // Create entry with initial refCount of 1
        const entry: ToolSessionEntry<TResult> = {
          session: session as ToolSession<TResult>,
          refCount: 1,
          createdAt: Date.now(),
          status: 'initializing',
        }
        yield* store.set(session.id, entry as ToolSessionEntry)

        // Spawn a task to monitor session status and update the store
        yield* spawn(function* () {
          // Poll status until session completes
          // In a more sophisticated implementation, we could use events
          let currentStatus: ToolSessionStatus = yield* session.status()

          while (
            currentStatus !== 'completed' &&
            currentStatus !== 'failed' &&
            currentStatus !== 'cancelled'
          ) {
            yield* store.updateStatus(session.id, currentStatus)

            // Simple polling - in production might use events
            yield* sleep(100)

            currentStatus = yield* session.status()
          }

          // Final status update
          yield* store.updateStatus(session.id, currentStatus)
        })

        return session
      },

      *get(sessionId: string): Operation<ToolSession | null> {
        const entry = yield* store.get(sessionId)
        if (!entry) return null

        // Return from active sessions if available
        const active = activeSessions.get(sessionId)
        if (active) return active

        // Entry exists but session not in active map - session may have been
        // orphaned (e.g., server restart). Return the entry's session reference.
        return entry.session
      },

      *acquire(sessionId: string): Operation<ToolSession> {
        const entry = yield* store.get(sessionId)
        if (!entry) {
          throw new Error(`Session not found: ${sessionId}`)
        }

        // Increment refCount
        yield* store.updateRefCount(sessionId, 1)

        // Return from active sessions if available
        const active = activeSessions.get(sessionId)
        if (active) return active

        // Return the entry's session reference
        return entry.session
      },

      *release(sessionId: string): Operation<void> {
        const entry = yield* store.get(sessionId)
        if (!entry) {
          // Session already cleaned up, nothing to do
          return
        }

        // Decrement refCount
        const newRefCount = yield* store.updateRefCount(sessionId, -1)

        if (newRefCount === 0) {
          // Check if session is complete
          const session = activeSessions.get(sessionId) ?? entry.session
          const status = yield* session.status()

          const isComplete =
            status === 'completed' ||
            status === 'failed' ||
            status === 'cancelled'

          if (isComplete) {
            // Session complete and no clients - cleanup immediately
            yield* cleanup(sessionId)
          } else {
            // Session still running - spawn cleanup waiter
            // This handles the case where client disconnects but tool is still executing
            yield* spawn(function* () {
              // Poll until session completes
              let currentStatus = yield* session.status()

              while (
                currentStatus !== 'completed' &&
                currentStatus !== 'failed' &&
                currentStatus !== 'cancelled'
              ) {
                yield* sleep(100)
                currentStatus = yield* session.status()
              }

              // Re-check refCount (client might have reconnected)
              const currentEntry = yield* store.get(sessionId)
              if (currentEntry && currentEntry.refCount === 0) {
                yield* cleanup(sessionId)
              }
            })
          }
        }
      },
    }

    yield* provide(registry)
  })
}
