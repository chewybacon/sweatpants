/**
 * Streaming Handler Primitive
 *
 * A higher-order function that bridges Effection operations to pull-based
 * ReadableStream for HTTP responses.
 *
 * The pattern:
 * 1. Handler receives request
 * 2. Creates scope, runs setup Operation to get subscription
 * 3. Setup Operation can access/modify HandlerContext (headers, etc.)
 * 4. Returns Response with ReadableStream that pulls via scope.run()
 * 5. Cleanup on completion or cancel
 */
import { createContext, createScope } from 'effection'
import type { Operation, Subscription } from 'effection'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Context available to the setup Operation.
 * Allows setting response headers, status, etc.
 */
export interface HandlerContext {
  /** The incoming request */
  request: Request
  /** Response headers (mutable during setup) */
  headers: Headers
  /** Response status code (default 200) */
  status: number
}

/**
 * Effection context for accessing HandlerContext from within Operations.
 */
export const HandlerContext = createContext<HandlerContext>('handler-context')

/**
 * Options for createStreamingHandler
 */
export interface StreamingHandlerOptions {
  /** Default headers to include in response */
  defaultHeaders?: HeadersInit
  /** Default status code (default 200) */
  defaultStatus?: number
  /** Serialize value to string (default: identity for strings, JSON.stringify for objects) */
  serialize?: (value: string) => string
  /** Custom error handler - return a Response or undefined to use default behavior */
  onSetupError?: (error: Error, ctx: HandlerContext) => Response | undefined
}

/**
 * Result from setup Operation.
 * Can be just a subscription, or include additional cleanup logic.
 */
export type SetupResult =
  | Subscription<string, void>
  | {
    subscription: Subscription<string, void>
    cleanup?: () => Operation<void>
  }

/**
 * Setup function signature - receives nothing, gets context via yield* HandlerContext.expect()
 */
export type SetupFn = () => Operation<SetupResult>

// =============================================================================
// HELPER: useHandlerContext
// =============================================================================

/**
 * Get the current handler context from within a setup Operation.
 *
 * @example
 * ```typescript
 * const handler = createStreamingHandler(function* () {
 *   const ctx = yield* useHandlerContext()
 *   const body = yield* call(() => ctx.request.json())
 *   ctx.headers.set('X-Session-Id', sessionId)
 *   return yield* createPullStream(buffer, 0)
 * })
 * ```
 */
export function* useHandlerContext(): Operation<HandlerContext> {
  return yield* HandlerContext.expect()
}

// =============================================================================
// MAIN: createStreamingHandler
// =============================================================================

/**
 * Create a streaming HTTP handler from an Effection setup Operation.
 *
 * The setup Operation:
 * - Runs in an Effection scope
 * - Can access HandlerContext via `yield* useHandlerContext()`
 * - Must return a Subscription<string, void> (or SetupResult with cleanup)
 *
 * The returned handler:
 * - Creates a scope per request
 * - Runs the setup Operation
 * - Returns a Response with pull-based ReadableStream
 * - Cleans up scope on stream completion or cancel
 *
 * @example
 * ```typescript
 * const handler = createStreamingHandler(function* () {
 *   const ctx = yield* useHandlerContext()
 *   const body = yield* call(() => ctx.request.json())
 *
 *   // Set response headers
 *   ctx.headers.set('X-Session-Id', crypto.randomUUID())
 *
 *   // Setup and return subscription
 *   const buffer = yield* acquireBuffer()
 *   return yield* createPullStream(buffer, 0)
 * })
 *
 * // Use as fetch handler
 * app.post('/api/chat', handler)
 * ```
 */
export function createStreamingHandler(
  setup: SetupFn,
  options: StreamingHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const {
    defaultHeaders = { 'Content-Type': 'application/x-ndjson' },
    defaultStatus = 200,
    serialize = (v: string) => v + '\n',
    onSetupError,
  } = options

  return async function handler(request: Request): Promise<Response> {
    const [scope, destroy] = createScope()
    const encoder = new TextEncoder()

    // Create mutable context for setup to modify
    const ctx: HandlerContext = {
      request,
      headers: new Headers(defaultHeaders),
      status: defaultStatus,
    }

    let subscription: Subscription<string, void>
    let cleanup: (() => Operation<void>) | undefined
    let cleanedUp = false
    let scopeDestroyed = false

    // Helper to run cleanup exactly once
    const runCleanup = async () => {
      if (cleanedUp) return
      cleanedUp = true
      if (cleanup && !scopeDestroyed) {
        try {
          await scope.run(cleanup)
        } catch {
          // Ignore cleanup errors
        }
      }
      if (!scopeDestroyed) {
        scopeDestroyed = true
        await destroy()
      }
    }

    try {
      // Run setup in scope with context
      const result = await scope.run(function*() {
        yield* HandlerContext.set(ctx)
        return yield* setup()
      })

      // Normalize result
      if ('subscription' in result) {
        subscription = result.subscription
        cleanup = result.cleanup
      } else {
        subscription = result
      }
    } catch (error) {
      // Setup failed - destroy scope and return error response
      await destroy()

      const err = error instanceof Error ? error : new Error('Setup failed')

      // Allow custom error handling
      if (onSetupError) {
        const customResponse = onSetupError(err, ctx)
        if (customResponse) {
          return customResponse
        }
      }

      // Default error response
      const errorBody = JSON.stringify({ error: err.message })
      return new Response(errorBody, {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Create pull-based stream
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // If scope was already destroyed (e.g., by cancel), just close
        if (scopeDestroyed) {
          controller.close()
          return
        }

        try {
          const result = await scope.run(function*() {
            return yield* subscription.next()
          })

          if (result.done) {
            controller.close()
            // Stream completed normally - run cleanup
            await runCleanup()
          } else {
            controller.enqueue(encoder.encode(serialize(result.value)))
          }
        } catch (error) {
          // Scope may have been destroyed (e.g., cancel was called)
          // or an error occurred during streaming
          if (!scopeDestroyed) {
            controller.error(error)
          } else {
            controller.close()
          }
          // Error during streaming - run cleanup
          await runCleanup()
        }
      },

      async cancel() {
        // Client disconnected - run cleanup
        await runCleanup()
      },
    })

    return new Response(stream, {
      status: ctx.status,
      headers: ctx.headers,
    })
  }
}
