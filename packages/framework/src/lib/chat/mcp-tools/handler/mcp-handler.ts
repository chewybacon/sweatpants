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
import { createScope, type Operation } from 'effection'
import { z } from 'zod'
import type { McpHandlerConfig, McpHttpHandler, McpClassifiedRequest, McpSessionState, McpInitializeRequest, McpToolsListRequest } from './types'
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
// INITIALIZE AND TOOLS/LIST RESPONSES
// =============================================================================

/**
 * Create an initialize response with server capabilities.
 */
function createInitializeResponse(
  request: McpInitializeRequest,
  _options: McpHandlerOptions
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: request.requestId,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {
          listChanged: false,
        },
        // We support elicitation and sampling
        elicitation: {},
        sampling: {},
      },
      serverInfo: {
        name: 'mcp-durable-runtime',
        version: '1.0.0',
      },
    },
  }
}

/**
 * Create a tools/list response.
 */
function createToolsListResponse(
  request: McpToolsListRequest,
  tools: Map<string, unknown>
): Record<string, unknown> {
  const toolList = Array.from(tools.entries()).map(([name, tool]) => {
    // Extract tool metadata - tools have name, description, and parameters (Zod schema)
    const t = tool as { description?: string; parameters?: z.ZodType }
    
    // Convert Zod schema to JSON Schema
    let inputSchema: Record<string, unknown> = { type: 'object', properties: {} }
    if (t.parameters) {
      try {
        inputSchema = z.toJSONSchema(t.parameters) as Record<string, unknown>
      } catch {
        // Fallback if conversion fails
      }
    }
    
    return {
      name,
      description: t.description ?? '',
      inputSchema,
    }
  })

  return {
    jsonrpc: '2.0',
    id: request.requestId,
    result: {
      tools: toolList,
    },
  }
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
        case 'initialize': {
          // Generate a session ID for this connection
          const initSessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
          
          // Respond with server capabilities and session ID
          const response = createInitializeResponse(classified, options)
          await destroy()
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 
              'Content-Type': 'application/json',
              'Mcp-Session-Id': initSessionId,
            },
          })
        }

        case 'tools_list': {
          // Respond with list of available tools
          const response = createToolsListResponse(classified, tools)
          await destroy()
          return new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'ping': {
          // Respond to ping
          await destroy()
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id: classified.requestId,
            result: {},
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        case 'notification': {
          // Notifications don't expect a response - just acknowledge
          await destroy()
          return new Response(null, { status: 202 })
        }

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

          // If no session ID or empty, return an idle SSE stream
          // This is used for general server notifications (not tool-specific)
          if (!sessionId) {
            return createIdleSseResponse(destroy, mergedSseOptions)
          }

          // Try to acquire the session
          try {
            const state = await scope.run(function* () {
              const s = yield* manager.acquireSession(sessionId)
              if (afterLSN !== undefined) {
                s.lastLSN = afterLSN
              }
              return s
            })

            return createSseResponse(scope, destroy, state, manager, mergedSseOptions)
          } catch {
            // Session not found - return idle stream instead of error
            return createIdleSseResponse(destroy, mergedSseOptions)
          }
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
// IDLE SSE RESPONSE (for connections without active sessions)
// =============================================================================

/**
 * Create an idle SSE stream for general server notifications.
 * 
 * This is returned when a client connects without a valid session ID.
 * It sends a keepalive comment every 30 seconds to keep the connection alive.
 */
function createIdleSseResponse(
  destroy: () => Promise<void>,
  options: SseStreamOptions
): Response {
  const { retryMs = 1000 } = options

  const headers = new Headers(createSseHeaders())
  const encoder = new TextEncoder()

  let intervalId: ReturnType<typeof setInterval> | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Send initial retry directive
      controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`))
      
      // Send keepalive comments every 30 seconds
      intervalId = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keepalive\n\n`))
        } catch {
          // Stream might be closed
          if (intervalId) {
            clearInterval(intervalId)
            intervalId = null
          }
        }
      }, 30000)
    },

    cancel() {
      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      destroy().catch(() => {})
    },
  })

  return new Response(stream, {
    status: 200,
    headers,
  })
}

// =============================================================================
// SSE RESPONSE HELPER
// =============================================================================

/**
 * Create an SSE Response from a session state.
 * 
 * Uses a queue-based pattern to bridge between Effection's cooperative
 * scheduling and the ReadableStream's pull-based model. A persistent
 * Effection task reads events and pushes them to a queue, while pull()
 * reads from the queue via Promises.
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

  // Queue for bridging Effection -> ReadableStream
  // Events are pushed by the Effection task, consumed by pull()
  const eventQueue: Array<IteratorResult<string, void>> = []
  let queueResolver: (() => void) | null = null
  let streamDone = false
  let scopeDestroyed = false

  // Helper to wait for queue to have items
  function waitForQueueItem(): Promise<void> {
    if (eventQueue.length > 0 || streamDone) {
      return Promise.resolve()
    }
    return new Promise<void>(resolve => {
      queueResolver = resolve
    })
  }

  // Helper to push to queue and wake up waiter
  function pushToQueue(item: IteratorResult<string, void>): void {
    eventQueue.push(item)
    if (queueResolver) {
      queueResolver()
      queueResolver = null
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Send prime event immediately
        const primeEvent = createPrimeEvent(sessionId, retryMs)
        controller.enqueue(encoder.encode(primeEvent))

        // Start a persistent Effection task that reads from subscription
        // and pushes to the queue. This scope.run() stays active until
        // the stream completes, which keeps the Effection scheduler running
        // and allows spawned tasks (like tool execution) to process events.
        // Start a persistent Effection task that reads from subscription
        // and pushes to the queue. This scope.run() stays active until
        // the stream completes, which keeps the Effection scheduler running
        // and allows spawned tasks (like tool execution) to process events.
        scope.run(function* () {
          try {
            const subscription = yield* createSseEventStream(state, manager, options)
            
            while (!scopeDestroyed) {
              const result = yield* subscription.next()
              pushToQueue(result)
              
              if (result.done) {
                break
              }
            }
          } catch (error) {
            // Push error as a special marker
            pushToQueue({ done: true, value: undefined })
            throw error
          } finally {
            streamDone = true
            // Wake up any waiting pull()
            if (queueResolver) {
              queueResolver()
              queueResolver = null
            }
          }
        }).catch(() => {
          // Errors will surface via queue, no need to log here
          streamDone = true
          if (queueResolver) {
            queueResolver()
            queueResolver = null
          }
        })
      } catch (error) {
        controller.error(error)
      }
    },

    async pull(controller) {
      if (scopeDestroyed) {
        controller.close()
        return
      }

      // Wait for an item in the queue
      await waitForQueueItem()

      // Get item from queue
      const result = eventQueue.shift()
      
      if (!result || result.done) {
        controller.close()
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
      } else {
        controller.enqueue(encoder.encode(result.value))
      }
    },

    async cancel() {
      if (!scopeDestroyed) {
        scopeDestroyed = true
        streamDone = true
        // Wake up any blocked queue wait
        if (queueResolver) {
          queueResolver()
          queueResolver = null
        }
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
