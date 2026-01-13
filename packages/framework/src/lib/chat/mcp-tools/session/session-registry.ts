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
 * - Tool execution runs in background via useBackgroundTask, surviving request teardown
 * - Reconnection works by acquiring the same sessionId while tool is still running
 *
 * @packageDocumentation
 */
import { type Operation, spawn, resource, sleep, createChannel, suspend } from 'effection'
import { useBackgroundTask } from '../../../effection/index.ts'
import type {
  ToolSessionRegistry,
  ToolSessionStore,
  ToolSession,
  ToolSessionEntry,
  ToolSessionOptions,
  ToolSessionSamplingProvider,
  ToolSessionStatus,
} from './types.ts'
import type { ElicitsMap } from '../mcp-tool-types.ts'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder.ts'
import { createToolSession } from './tool-session.ts'

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
 * IMPORTANT: Session creation uses useBackgroundTask() to ensure the tool session
 * lives in an independent scope. This allows sessions to survive across HTTP
 * request boundaries even when the chat-engine scope for a single request exits
 * immediately after emitting an elicitation event.
 *
 * @param store - Store for tracking session entries
 * @param options - Registry configuration options
 * @returns ToolSessionRegistry resource
 */
export function createToolSessionRegistry(
  store: ToolSessionStore,
  options: ToolSessionRegistryOptions
): Operation<ToolSessionRegistry> {
  return resource<ToolSessionRegistry>(function* (provide) {
    const { samplingProvider, defaultTimeout } = options

    // Track active session resources
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
        const mergedOptions: ToolSessionOptions = {
          ...sessionOptions,
          ...(defaultTimeout !== undefined && { timeout: defaultTimeout }),
        }

        // Use a channel to receive the session from the spawned task
        const sessionChannel = createChannel<ToolSession<TResult>, void>()

        // CRITICAL: Run tool sessions in an independent background scope.
        //
        // The durable chat handler can end the current request scope immediately
        // after emitting a plugin elicitation event. If the tool session lived in
        // that request scope, it would be cancelled and could not be resumed on
        // the next HTTP request.
        yield* useBackgroundTask(function* () {
          const session = yield* createToolSession(
            tool,
            params,
            samplingProvider,
            mergedOptions
          )

          // Send session back to caller
          yield* sessionChannel.send(session)

          // Keep this task alive until the session completes
          // This ensures the session's spawned tasks continue running
          while (true) {
            const status = yield* session.status()
            if (status === 'completed' || status === 'failed' || status === 'cancelled') {
              break
            }
            yield* sleep(100)
          }
        }, { name: `tool-session:${mergedOptions.sessionId ?? tool.name}` })

        // Receive the session from the spawned task
        const sub = yield* sessionChannel
        const result = yield* sub.next()
        if (result.done) {
          throw new Error('Session channel closed unexpectedly')
        }
        const session = result.value

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

        // Spawn status monitor
        yield* spawn(function* () {
          let currentStatus: ToolSessionStatus = yield* session.status()

          while (
            currentStatus !== 'completed' &&
            currentStatus !== 'failed' &&
            currentStatus !== 'cancelled'
          ) {
            yield* store.updateStatus(session.id, currentStatus)
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
            yield* spawn(function* () {
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
    
    // Keep the registry alive - it should only be torn down when the parent scope ends
    yield* suspend()
  })
}
