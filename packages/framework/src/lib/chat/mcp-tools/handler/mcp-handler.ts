/**
 * MCP HTTP Handler
 *
 * Main entry point for the MCP Streamable HTTP handler.
 *
 * ## Overview
 *
 * This handler implements the MCP Streamable HTTP transport (spec 2025-11-25),
 * providing a single endpoint that supports:
 *
 * - **POST** - Execute tools, send elicit/sample responses
 * - **GET** - Establish SSE stream for server→client messages
 * - **DELETE** - Terminate a session
 *
 * ## Usage
 *
 * ```typescript
 * import { createMcpHandler } from './handler'
 * import { createSessionRegistry } from '../session'
 *
 * const registry = createSessionRegistry(store)
 * const tools = new Map([['my_tool', myTool]])
 *
 * const { handler } = createMcpHandler({
 *   registry,
 *   tools,
 * })
 *
 * // Use with any HTTP framework
 * app.all('/mcp', handler)
 * ```
 *
 * @packageDocumentation
 */
import { createScope, type Operation, type Subscription } from 'effection'
import type { McpHandlerConfig, McpHttpHandler, McpClassifiedRequest, McpSessionState } from './types'
import { McpHandlerError } from './types'
import { parseAndClassify } from './request-parser'
import { createSessionManager, type McpSessionManager } from './session-manager'
import { handlePost, type PostHandlerOptions } from './post-handler'
import { createSseEventStream, type SseStreamOptions } from './get-handler'
import {
  createPrimeEvent,
  createSseHeaders,
} from '../protocol/sse-formatter'
import { JSON_RPC_ERROR_CODES } from '../protocol/types'

// =============================================================================
// HANDLER OPTIONS
// =============================================================================

/**
 * Full options for creating an MCP handler.
 */
export interface McpHandlerOptions extends McpHandlerConfig {
  /** POST handler options */
  postOptions?: PostHandlerOptions | undefined
  /** SSE stream options */
  sseOptions?: SseStreamOptions | undefined
}

// =============================================================================
// ERROR RESPONSE HELPERS
// =============================================================================

/**
 * Create a JSON-RPC error response.
 */
function createJsonRpcErrorResponse(
  code: number,
  message: string,
  id: string | number | null = null
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  }
}

/**
 * Create an HTTP error response.
 */
function createErrorResponse(
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>
): Response {
  const body = createJsonRpcErrorResponse(code, message)
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  })
}

// =============================================================================
// MAIN HANDLER FACTORY
// =============================================================================

/**
 * Create an MCP HTTP handler.
 *
 * The handler manages tool execution sessions and implements the
 * MCP Streamable HTTP transport protocol.
 */
export function createMcpHandler(options: McpHandlerOptions): {
  handler: McpHttpHandler
  manager: McpSessionManager
} {
  const {
    registry,
    tools,
    sessionTimeout,
    sseRetryMs = 1000,
    logger = 'mcp-handler',
    includeStackTraces = false,
    postOptions = {},
    sseOptions = {},
  } = options

  // Create session manager
  const manager = createSessionManager({
    registry,
    tools,
    sessionTimeout,
  })

  // Merge SSE options with defaults
  const mergedSseOptions: SseStreamOptions = {
    retryMs: sseRetryMs,
    logger,
    ...sseOptions,
  }

  /**
   * The main HTTP handler function.
   */
  const handler: McpHttpHandler = async (request: Request): Promise<Response> => {
    const [scope, destroy] = createScope()

    try {
      // Parse and classify the request
      let classified: McpClassifiedRequest
      try {
        classified = await scope.run(function* () {
          return yield* parseAndClassify(request)
        })
      } catch (error) {
        await destroy()
        if (error instanceof McpHandlerError) {
          return createErrorResponse(
            error.httpStatus,
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            error.message
          )
        }
        throw error
      }

      // Handle based on request type
      switch (classified.type) {
        case 'tools_call':
        case 'elicit_response':
        case 'sample_response': {
          // POST requests
          const result = await scope.run(function* () {
            return yield* handlePost(classified, manager, postOptions)
          })

          if (result.type === 'json') {
            await destroy()
            return new Response(JSON.stringify(result.body), {
              status: result.status,
              headers: {
                'Content-Type': 'application/json',
                ...result.headers,
              },
            })
          }

          // Upgrade to SSE - get session state
          const { sessionId } = result
          const state = await scope.run(function* () {
            return yield* manager.getSession(sessionId)
          })

          if (!state) {
            await destroy()
            return createErrorResponse(
              404,
              JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
              'Session state not found'
            )
          }

          // Create SSE response
          return createSseResponse(scope, destroy, state, manager, mergedSseOptions)
        }

        case 'sse_stream': {
          // GET request for SSE
          const { sessionId, afterLSN } = classified

          const state = await scope.run(function* () {
            const s = yield* manager.acquireSession(sessionId)
            if (afterLSN !== undefined) {
              s.lastLSN = afterLSN
            }
            return s
          })

          return createSseResponse(scope, destroy, state, manager, mergedSseOptions)
        }

        case 'terminate': {
          // DELETE request
          const { sessionId } = classified

          await scope.run(function* () {
            yield* manager.terminateSession(sessionId)
          })

          await destroy()
          return new Response(null, { status: 204 })
        }

        default:
          await destroy()
          return createErrorResponse(
            400,
            JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            'Unknown request type'
          )
      }
    } catch (error) {
      await destroy()

      if (error instanceof McpHandlerError) {
        return createErrorResponse(
          error.httpStatus,
          JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
          error.message
        )
      }

      const message = includeStackTraces && error instanceof Error
        ? `${error.message}\n${error.stack}`
        : 'Internal server error'

      return createErrorResponse(
        500,
        JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
        message
      )
    }
  }

  return { handler, manager }
}

// =============================================================================
// SSE RESPONSE HELPER
// =============================================================================

/**
 * Create an SSE Response from a session state.
 */
function createSseResponse(
  scope: { run: <T>(op: () => Operation<T>) => Promise<T> },
  destroy: () => Promise<void>,
  state: McpSessionState,
  manager: McpSessionManager,
  options: SseStreamOptions
): Response {
  const { sessionId } = state
  const { retryMs = 1000 } = options

  // Build headers
  const headers = new Headers(createSseHeaders())
  headers.set('Mcp-Session-Id', sessionId)

  // Encoder for stream
  const encoder = new TextEncoder()

  // Track cleanup state
  let subscription: Subscription<string, void> | null = null
  let scopeDestroyed = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Get subscription
        subscription = await scope.run(function* () {
          return yield* createSseEventStream(state, manager, options)
        })

        // Send prime event
        const primeEvent = createPrimeEvent(sessionId, retryMs)
        controller.enqueue(encoder.encode(primeEvent))
      } catch (error) {
        controller.error(error)
      }
    },

    async pull(controller) {
      if (scopeDestroyed || !subscription) {
        controller.close()
        return
      }

      try {
        const result = await scope.run(function* () {
          return yield* subscription!.next()
        })

        if (result.done) {
          controller.close()
          if (!scopeDestroyed) {
            scopeDestroyed = true
            await scope.run(function* () {
              yield* manager.releaseSession(sessionId)
            })
            await destroy()
          }
        } else {
          controller.enqueue(encoder.encode(result.value))
        }
      } catch (error) {
        if (!scopeDestroyed) {
          controller.error(error)
          scopeDestroyed = true
          try {
            await destroy()
          } catch {
            // Ignore cleanup errors
          }
        } else {
          controller.close()
        }
      }
    },

    async cancel() {
      if (!scopeDestroyed) {
        scopeDestroyed = true
        try {
          await scope.run(function* () {
            yield* manager.releaseSession(sessionId)
          })
        } catch {
          // Ignore release errors
        }
        try {
          await destroy()
        } catch {
          // Ignore destroy errors
        }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers,
  })
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type { McpHandlerConfig, McpHttpHandler } from './types'
export { McpHandlerError, MCP_HANDLER_ERRORS } from './types'
