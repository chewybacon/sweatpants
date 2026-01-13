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
 * - LLM writer tasks run in background via useBackgroundTask, surviving client disconnects
 * - Reconnection works by acquiring the same sessionId while LLM is still streaming
 */
import type { Operation } from 'effection'
import type {
  TokenBufferStore,
  SessionRegistry,
  SessionRegistryStore,
  SessionEntry,
  SessionHandle,
  SessionStatus,
  CreateSessionOptions,
} from './types.ts'
import { writeFromStreamToBuffer } from './pull-stream.ts'
import { useLogger, LoggerFactoryContext } from '../../logger/index.ts'
import { useBackgroundTask, type BackgroundTaskHandle } from '../../effection/index.ts'

/**
 * Internal mutable state for tracking session status.
 * Updated by the writer task, read by the status() method.
 */
interface MutableSessionState {
  status: SessionStatus
}

/**
 * Task keys for internal task tracking.
 * Background tasks are stored in a separate map (not in SessionEntry)
 * because SessionEntry must remain serializable for pluggable stores.
 */
const TASK_KEYS = {
  WRITER: 'writer',
} as const

/**
 * Creates a SessionRegistry for managing session lifecycles.
 *
 * The registry manages writer tasks internally using useBackgroundTask,
 * allowing them to run independently without blocking request completion.
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
  const log = yield* useLogger('durable-streams:registry')
  
  // Track mutable state for each session (status updates from writer tasks)
  const sessionStates = new Map<string, MutableSessionState>()
  
  // Internal task tracking - NOT in SessionEntry to keep it serializable
  // Map<sessionId, Map<taskKey, BackgroundTaskHandle>>
  const sessionTasks = new Map<string, Map<string, BackgroundTaskHandle<void>>>()

  /**
   * Internal cleanup helper - removes session from all stores and maps.
   */
  function* cleanup(sessionId: string): Operation<void> {
    log.debug({ sessionId }, 'cleaning up session')
    yield* registryStore.delete(sessionId)
    yield* bufferStore.delete(sessionId)
    sessionStates.delete(sessionId)
    sessionTasks.delete(sessionId)
  }

  const registry: SessionRegistry<T> = {
    *acquire(
      sessionId: string,
      options?: CreateSessionOptions<T>
    ): Operation<SessionHandle<T>> {
      log.debug({ sessionId, hasSource: !!options?.source }, 'acquire called')
      
      // Check if session already exists
      const existing = yield* registryStore.get(sessionId)

      if (existing) {
        // Increment refCount and return existing handle
        yield* registryStore.updateRefCount(sessionId, 1)
        log.debug({ sessionId }, 'returning existing session')
        return existing.handle
      }

      // Create new session - requires source stream
      if (!options?.source) {
        log.debug({ sessionId }, 'no source provided, throwing error')
        throw new Error('Session not found and no source provided')
      }

      // Create buffer for this session
      log.debug({ sessionId }, 'creating buffer')
      const buffer = yield* bufferStore.create(sessionId)
      log.debug({ sessionId }, 'buffer created')

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

      // Get logger factory for context handoff to background task
      const loggerFactory = yield* LoggerFactoryContext.get()
      const source = options.source
      
      log.debug({ sessionId }, 'starting writer task via useBackgroundTask')
      
      // Start writer as background task - runs independently, doesn't block parent scope
      const writerTask = yield* useBackgroundTask(
        function* () {
          const writerLog = yield* useLogger('durable-streams:writer')
          writerLog.debug({ sessionId }, 'writer task started')
          try {
            yield* writeFromStreamToBuffer(source, buffer)
            state.status = 'complete'
            writerLog.debug({ sessionId }, 'writer task completed')
          } catch (err) {
            state.status = 'error'
            writerLog.error({ sessionId, error: (err as Error).message }, 'writer task failed')
            yield* buffer.fail(err as Error)
          }
        },
        {
          name: `writer:${sessionId}`,
          // Pass logger factory context so useLogger works in background task
          // Cast needed due to contravariance in ContextEntry generics
          contexts: loggerFactory
            ? [{ context: LoggerFactoryContext, value: loggerFactory } as any]
            : [],
        }
      )
      
      // Store task handle in internal map (not in SessionEntry - keep it serializable)
      const tasks = new Map<string, BackgroundTaskHandle<void>>()
      tasks.set(TASK_KEYS.WRITER, writerTask)
      sessionTasks.set(sessionId, tasks)
      
      log.debug({ sessionId }, 'writer task started')

      // Store session entry with initial refCount of 1
      const entry: SessionEntry<T> = {
        handle,
        refCount: 1,
        createdAt: Date.now(),
      }
      yield* registryStore.set(sessionId, entry)
      log.debug({ sessionId }, 'session entry stored, acquire complete')

      return handle
    },

    *release(sessionId: string): Operation<void> {
      log.debug({ sessionId }, 'release called')
      const entry = yield* registryStore.get(sessionId)
      if (!entry) {
        log.debug({ sessionId }, 'session not found, nothing to release')
        return
      }

      // Decrement refCount
      const newRefCount = yield* registryStore.updateRefCount(sessionId, -1)
      log.debug({ sessionId, newRefCount }, 'refCount decremented')

      if (newRefCount === 0) {
        // Get writer task handle from internal map
        const tasks = sessionTasks.get(sessionId)
        const writerTask = tasks?.get(TASK_KEYS.WRITER)
        
        if (writerTask?.isDone()) {
          // Writer is done and no clients - cleanup immediately
          log.debug({ sessionId, writerStatus: writerTask.status() }, 'writer done, cleaning up immediately')
          yield* cleanup(sessionId)
        } else {
          // Writer still running - spawn cleanup waiter as background task
          // This handles the case where client disconnects but LLM is still writing
          log.debug({ sessionId }, 'writer still running, spawning cleanup waiter')
          
          // Capture references for closure
          const capturedRegistryStore = registryStore
          const capturedCleanup = cleanup
          const capturedLog = log
          
          // Use useBackgroundTask instead of fireAndForget to ensure the scope stays alive
          yield* useBackgroundTask(function* () {
            // Wait for writer to complete
            if (writerTask) {
              yield* writerTask.waitForDone()
            }
            
            // Re-check refCount (client might have reconnected)
            const currentEntry = yield* capturedRegistryStore.get(sessionId)
            if (currentEntry && currentEntry.refCount === 0) {
              capturedLog.debug({ sessionId }, 'cleanup waiter: cleaning up session')
              yield* capturedCleanup(sessionId)
            } else {
              capturedLog.debug({ sessionId, refCount: currentEntry?.refCount }, 'cleanup waiter: client reconnected, skipping cleanup')
            }
          }, { name: `cleanup-waiter:${sessionId}` })
        }
      }
    },
  }

  log.debug('session registry created')
  return registry
}
