/**
 * Session Registry Implementation
 *
 * Manages session lifecycle with reference counting and durable retention.
 * Sessions represent the duration of a single LLM request, not the entire
 * chat conversation.
 *
 * Key behaviors:
 * - acquire() creates or returns existing session, increments refCount
 * - release() decrements refCount, detaches runtime tasks when refCount=0
 * - LLM writer tasks run in background via useBackgroundTask, surviving client disconnects
 * - Reconnection works by acquiring the same sessionId while LLM is still streaming
 */
import { sleep, type Operation } from 'effection'
import type {
  TokenBufferStore,
  TokenBuffer,
  SessionRegistry,
  SessionRegistryStore,
  SessionEntry,
  SessionHandle,
  SessionStatus,
  CreateSessionOptions,
  RetentionPolicy,
} from '@sweatpants/durable-streams'
import { DEFAULT_RETENTION_POLICY, writeFromStreamToBuffer } from '@sweatpants/durable-streams'
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
  registryStore: SessionRegistryStore,
  config: { retentionPolicy?: RetentionPolicy } = {}
): Operation<SessionRegistry<T>> {
  const log = yield* useLogger('durable-streams:registry')
  const retentionPolicy = config.retentionPolicy ?? DEFAULT_RETENTION_POLICY
  
  // Track mutable state for each session (status updates from writer tasks)
  const sessionStates = new Map<string, MutableSessionState>()
  
  // Internal task tracking - NOT in SessionEntry to keep it serializable
  // Map<sessionId, Map<taskKey, BackgroundTaskHandle>>
  const sessionTasks = new Map<string, Map<string, BackgroundTaskHandle<void>>>()
  const retentionTasks = new Map<string, BackgroundTaskHandle<void>>()

  function createHandle(
    sessionId: string,
    buffer: TokenBuffer<T>,
  ): SessionHandle<T> {
    return {
      id: sessionId,
      buffer,
      *status(): Operation<SessionStatus> {
        const state = sessionStates.get(sessionId)
        if (state) {
          return state.status
        }

        const error = yield* buffer.getError()
        if (error) {
          return 'error'
        }

        const complete = yield* buffer.isComplete()
        return complete ? 'complete' : 'streaming'
      },
    }
  }

  /**
 * Internal runtime cleanup helper.
 *
 * Durable entries and buffers remain in stores for replay/reconnect.
 */
  function* cleanupRuntime(sessionId: string): Operation<void> {
    log.debug({ sessionId }, 'cleaning up runtime task state')
    sessionStates.delete(sessionId)
    sessionTasks.delete(sessionId)
  }

  function* clearRetentionTask(sessionId: string): Operation<void> {
    const pending = retentionTasks.get(sessionId)
    if (pending) {
      yield* pending.halt()
      retentionTasks.delete(sessionId)
    }
  }

  function* deleteDurableState(sessionId: string): Operation<void> {
    yield* registryStore.delete(sessionId)
    yield* bufferStore.delete(sessionId)
    yield* cleanupRuntime(sessionId)
  }

  function* scheduleTtlDeletion(sessionId: string, ttlMs: number): Operation<void> {
    if (ttlMs <= 0) {
      log.debug({ sessionId }, 'retention ttl expired immediately, deleting')
      yield* deleteDurableState(sessionId)
      return
    }

    const task = yield* useBackgroundTask(function* () {
      yield* sleep(ttlMs)
      const entry = yield* registryStore.get(sessionId)
      if (entry && entry.refCount === 0) {
        log.debug({ sessionId, ttlMs }, 'retention ttl reached, deleting')
        yield* deleteDurableState(sessionId)
      }
    }, {
      name: `retention-ttl:${sessionId}`,
    })

    retentionTasks.set(sessionId, task)
  }

  function* applyRetentionPolicy(
    sessionId: string,
    buffer: TokenBuffer<T>
  ): Operation<void> {
    const complete = yield* buffer.isComplete()
    const error = yield* buffer.getError()
    const succeeded = complete && !error

    switch (retentionPolicy.mode) {
      case 'auto_delete_on_close': {
        if (succeeded) {
          log.debug({ sessionId }, 'auto-delete retention deleting successful session')
          yield* deleteDurableState(sessionId)
        } else {
          log.debug({ sessionId }, 'auto-delete retention preserving non-successful session')
          yield* cleanupRuntime(sessionId)
        }
        return
      }

      case 'retain_until_ttl': {
        log.debug({ sessionId, ttlMs: retentionPolicy.ttlMs }, 'retaining session until ttl')
        yield* cleanupRuntime(sessionId)
        yield* clearRetentionTask(sessionId)
        yield* scheduleTtlDeletion(sessionId, retentionPolicy.ttlMs)
        return
      }

      case 'retain_forever':
      default: {
        log.debug({ sessionId }, 'retaining session forever')
        yield* cleanupRuntime(sessionId)
      }
    }
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
        yield* clearRetentionTask(sessionId)

        // Increment refCount and return existing handle
        yield* registryStore.updateRefCount(sessionId, 1)

        const buffer = yield* bufferStore.get(sessionId)
        if (!buffer) {
          throw new Error(`Session ${sessionId} metadata exists but buffer missing`)
        }

        log.debug({ sessionId }, 'returning existing session')
        return createHandle(sessionId, buffer)
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
      const handle = createHandle(sessionId, buffer)

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
          contexts: loggerFactory
            ? [{ context: LoggerFactoryContext, value: loggerFactory }]
            : [],
        }
      )
      
      // Store task handle in internal map (not in SessionEntry - keep it serializable)
      const tasks = new Map<string, BackgroundTaskHandle<void>>()
      tasks.set(TASK_KEYS.WRITER, writerTask)
      sessionTasks.set(sessionId, tasks)
      
      log.debug({ sessionId }, 'writer task started')

      // Store session entry with initial refCount of 1
      const entry: SessionEntry = {
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
          log.debug({ sessionId, writerStatus: writerTask.status() }, 'writer done, applying retention policy')
          const buffer = yield* bufferStore.get(sessionId)
          if (buffer) {
            yield* applyRetentionPolicy(sessionId, buffer)
          }
        } else {
          // Writer still running - spawn runtime cleanup waiter as background task.
          // This handles the case where client disconnects but LLM is still writing
          log.debug({ sessionId }, 'writer still running, spawning runtime cleanup waiter')
          
          // Capture references for closure
          const capturedRegistryStore = registryStore
          const capturedCleanupRuntime = cleanupRuntime
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
              capturedLog.debug({ sessionId }, 'cleanup waiter: applying retention policy')
              const buffer = yield* bufferStore.get(sessionId)
              if (buffer) {
                yield* applyRetentionPolicy(sessionId, buffer)
              } else {
                yield* capturedCleanupRuntime(sessionId)
              }
            } else {
              capturedLog.debug({ sessionId, refCount: currentEntry?.refCount }, 'cleanup waiter: client reconnected, keeping runtime state')
            }
          }, { name: `cleanup-waiter:${sessionId}` })
        }
      }
    },
  }

  log.debug('session registry created')
  return registry
}
