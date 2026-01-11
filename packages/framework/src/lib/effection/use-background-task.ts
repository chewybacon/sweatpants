/**
 * useBackgroundTask Hook
 * 
 * A higher-order Effection hook for running operations in the background
 * without blocking the parent scope's completion.
 * 
 * ## Problem
 * In Effection, `scope.run()` waits for all spawned tasks and resources to complete.
 * This is usually desirable, but for scenarios like:
 * - HTTP handlers that need to return a Response while a writer continues
 * - Long-running background processes that shouldn't block request completion
 * 
 * ## Solution
 * This hook creates an independent scope for background work, allowing the parent
 * scope to complete immediately while providing a handle for monitoring and control.
 * 
 * ## Context Propagation
 * 
 * Because the background task runs in an independent scope (not a child scope),
 * Effection contexts are NOT automatically inherited. This is intentional - if we
 * used a child scope, the parent would wait for the background task to complete.
 * 
 * To pass contexts to a background task, use the `contexts` option:
 * 
 * ```typescript
 * // Get the logger factory from current scope
 * const loggerFactory = yield* LoggerFactoryContext.get()
 * 
 * const handle = yield* useBackgroundTask(function* () {
 *   // Context is now available!
 *   const logger = yield* useLogger('background')
 *   logger.debug('running in background')
 * }, {
 *   contexts: [
 *     { context: LoggerFactoryContext, value: loggerFactory },
 *   ]
 * })
 * ```
 * 
 * Or capture values via closure:
 * 
 * ```typescript
 * const logger = yield* useLogger('handler')
 * 
 * const handle = yield* useBackgroundTask(function* () {
 *   // Use captured logger via closure
 *   logger.debug('running in background')
 * })
 * ```
 * 
 * ## Usage
 * ```typescript
 * const handle = yield* useBackgroundTask(function* () {
 *   // This work runs in the background
 *   yield* longRunningOperation()
 * })
 * 
 * // Parent can continue immediately
 * console.log('Background task started')
 * 
 * // Check status
 * console.log(handle.status()) // 'running'
 * 
 * // Wait for completion if needed
 * yield* handle.waitForDone()
 * 
 * // Or halt it
 * yield* handle.halt()
 * ```
 */

import { createScope, call, resource } from 'effection'
import type { Operation, Scope, Context } from 'effection'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Status of a background task.
 */
export type BackgroundTaskStatus = 
  | 'pending'    // Created but not yet started
  | 'running'    // Currently executing
  | 'complete'   // Finished successfully
  | 'error'      // Finished with error
  | 'halted'     // Cancelled via halt()

/**
 * Handle for controlling a background task.
 */
export interface BackgroundTaskHandle<T = void> {
  /** Get current status of the task */
  status(): BackgroundTaskStatus
  
  /** Get the result (only defined when status is 'complete') */
  result(): T | undefined
  
  /** Get the error (only defined when status is 'error') */
  error(): Error | undefined
  
  /** Check if task is done (complete, error, or halted) */
  isDone(): boolean
  
  /** Wait for task to finish (resolves when done) */
  waitForDone(): Operation<BackgroundTaskStatus>
  
  /** Halt the task (cancel it) */
  halt(): Operation<void>
  
  /** Pause the task (if supported by the operation) */
  pause(): Operation<void>
  
  /** Resume the task (if paused) */
  resume(): Operation<void>
}

/**
 * A context value to be passed to the background task.
 */
export interface ContextEntry<T = unknown> {
  context: Context<T>
  value: T
}

/**
 * Options for useBackgroundTask.
 */
export interface BackgroundTaskOptions {
  /** 
   * External scope to run the task in. 
   * If not provided, a new independent scope is created.
   */
  scope?: Scope
  
  /**
   * Context values to propagate to the background task.
   * Since background tasks run in independent scopes, contexts must be
   * explicitly passed to avoid the parent scope waiting for the child.
   * 
   * @example
   * ```typescript
   * const logger = yield* useLogger('handler')
   * const handle = yield* useBackgroundTask(work, {
   *   contexts: [
   *     { context: LoggerFactoryContext, value: loggerFactory },
   *   ]
   * })
   * ```
   */
  contexts?: ContextEntry[]
  
  /**
   * Name for logging/debugging purposes.
   */
  name?: string
  
  /**
   * Callback when task completes.
   */
  onComplete?: () => void
  
  /**
   * Callback when task errors.
   */
  onError?: (error: Error) => void
  
  /**
   * Callback when task is halted.
   */
  onHalt?: () => void
}

// =============================================================================
// INTERNAL STATE
// =============================================================================

/**
 * A simple awaitable that can be resolved from outside.
 * Unlike Effection signals, this works across scopes and doesn't require
 * the waiter to be listening before the value is sent.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
  resolved: boolean
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void
  let reject: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return {
    promise,
    resolve: (value: T) => {
      resolve(value)
    },
    reject: (error: Error) => {
      reject(error)
    },
    resolved: false,
  }
}

interface TaskState<T> {
  status: BackgroundTaskStatus
  result: T | undefined
  error: Error | undefined
  paused: boolean
  doneDeferred: Deferred<BackgroundTaskStatus>
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create and run a background task that doesn't block the parent scope.
 * 
 * The task runs in a separate scope (either provided or created), allowing
 * the calling operation to continue immediately while providing a handle
 * for monitoring and control.
 * 
 * @param operation - The operation to run in the background
 * @param options - Configuration options
 * @returns A handle for controlling the background task
 * 
 * @example Basic usage
 * ```typescript
 * function* myHandler() {
 *   const handle = yield* useBackgroundTask(function* () {
 *     yield* writeToBuffer(stream, buffer)
 *   })
 *   
 *   // Returns immediately, writer continues in background
 *   return createResponse(buffer)
 * }
 * ```
 * 
 * @example With status monitoring
 * ```typescript
 * const handle = yield* useBackgroundTask(function* () {
 *   for (const item of items) {
 *     yield* processItem(item)
 *   }
 * }, { name: 'item-processor' })
 * 
 * // Poll status
 * while (!handle.isDone()) {
 *   console.log('Status:', handle.status())
 *   yield* sleep(100)
 * }
 * ```
 * 
 * @example With external scope
 * ```typescript
 * const [bgScope, destroyBg] = createScope()
 * 
 * const handle = yield* useBackgroundTask(work, { scope: bgScope })
 * 
 * // Later, cleanup
 * yield* handle.halt()
 * await destroyBg()
 * ```
 */
export function* useBackgroundTask<T = void>(
  operation: () => Operation<T>,
  options: BackgroundTaskOptions = {}
): Operation<BackgroundTaskHandle<T>> {
  const { scope: externalScope, contexts = [], onComplete, onError, onHalt } = options
  
  // Create state tracking
  const state: TaskState<T> = {
    status: 'pending',
    result: undefined,
    error: undefined,
    paused: false,
    doneDeferred: createDeferred<BackgroundTaskStatus>(),
  }
  
  // Create scope if not provided
  // IMPORTANT: We always create an independent scope (not a child scope)
  // because child scopes would cause the parent to wait for us.
  // Contexts must be passed explicitly via the `contexts` option.
  let scope: Scope
  let destroyScope: (() => Promise<void>) | undefined
  
  if (externalScope) {
    // Use the provided external scope directly
    scope = externalScope
  } else {
    // Create an independent scope
    const [newScope, destroy] = createScope()
    scope = newScope
    destroyScope = destroy
  }
  
  // Create the handle
  const handle: BackgroundTaskHandle<T> = {
    status: () => state.status,
    result: () => state.result,
    error: () => state.error,
    isDone: () => state.status === 'complete' || state.status === 'error' || state.status === 'halted',
    
    *waitForDone() {
      if (!handle.isDone()) {
        yield* call(() => state.doneDeferred.promise)
      }
      return state.status
    },
    
    *halt() {
      if (state.status === 'running' || state.status === 'pending') {
        state.status = 'halted'
        state.doneDeferred.resolve('halted')
        onHalt?.()
        if (destroyScope) {
          yield* call(() => destroyScope!())
        }
      }
    },
    
    *pause() {
      if (state.status === 'running') {
        state.paused = true
      }
    },
    
    *resume() {
      if (state.paused) {
        state.paused = false
        // Resume would need additional signaling - simplified for now
      }
    },
  }
  
  // Start the task in the background scope
  // IMPORTANT: We use scope.run() NOT spawn() so the parent doesn't wait
  state.status = 'running'
  
  scope.run(function* () {
    try {
      // Set up contexts in the new scope
      for (const entry of contexts) {
        yield* entry.context.set(entry.value)
      }
      
      const result = yield* operation()
      
      if (state.status === 'running') {
        state.status = 'complete'
        state.result = result
        onComplete?.()
        state.doneDeferred.resolve('complete')
      }
    } catch (err) {
      // Check if it was a halt
      if (state.status === 'halted') {
        // Already handled in halt()
        return
      }
      
      state.status = 'error'
      state.error = err instanceof Error ? err : new Error(String(err))
      onError?.(state.error)
      state.doneDeferred.resolve('error')
    }
  })
  
  // Return the handle immediately (don't wait for task to complete)
  return handle
}



// =============================================================================
// CONVENIENCE HOOKS
// =============================================================================

/**
 * Run an operation in an independent scope (fire-and-forget).
 * 
 * Unlike useBackgroundTask, this doesn't provide a handle - the task
 * runs fire-and-forget style. Useful for cleanup tasks or monitoring.
 * 
 * NOTE: The operation runs in an independent scope, so contexts are NOT
 * automatically inherited. Capture any needed values via closure.
 * 
 * @param operation - The operation to run
 * 
 * @example
 * ```typescript
 * const logger = yield* useLogger('handler')
 * 
 * yield* fireAndForget(function* () {
 *   // Use captured logger via closure
 *   logger.debug('sending metrics')
 *   yield* sendMetrics(data)
 * })
 * ```
 */
export function* fireAndForget(operation: () => Operation<void>): Operation<void> {
  const [scope] = createScope()
  scope.run(operation)
  // Don't wait for it
}

/**
 * Create a task pool for running multiple background tasks with concurrency control.
 * 
 * @param maxConcurrent - Maximum number of tasks to run concurrently
 * 
 * @example
 * ```typescript
 * const pool = yield* useTaskPool(3)
 * 
 * for (const item of items) {
 *   yield* pool.submit(function* () {
 *     yield* processItem(item)
 *   })
 * }
 * 
 * yield* pool.waitAll()
 * ```
 */
export function useTaskPool(maxConcurrent: number): Operation<TaskPool> {
  return resource(function* (provide) {
    const handles: BackgroundTaskHandle<void>[] = []
    let running = 0
    const waitQueue: Array<() => void> = []
    
    const pool: TaskPool = {
      *submit(operation) {
        // Wait if at capacity
        while (running >= maxConcurrent) {
          yield* call(() => new Promise<void>(resolve => waitQueue.push(resolve)))
        }
        
        running++
        const handle = yield* useBackgroundTask(function* () {
          try {
            yield* operation()
          } finally {
            running--
            const next = waitQueue.shift()
            if (next) next()
          }
        })
        handles.push(handle)
        return handle
      },
      
      *waitAll() {
        for (const handle of handles) {
          yield* handle.waitForDone()
        }
      },
      
      *haltAll() {
        for (const handle of handles) {
          yield* handle.halt()
        }
      },
      
      activeCount: () => running,
    }
    
    yield* provide(pool)
  })
}

/**
 * Task pool for managing concurrent background tasks.
 */
export interface TaskPool {
  /** Submit a task to the pool */
  submit(operation: () => Operation<void>): Operation<BackgroundTaskHandle<void>>
  
  /** Wait for all submitted tasks to complete */
  waitAll(): Operation<void>
  
  /** Halt all running tasks */
  haltAll(): Operation<void>
  
  /** Get count of currently running tasks */
  activeCount(): number
}
