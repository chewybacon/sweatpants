/**
 * MCP GET Request Handler (SSE Streaming)
 *
 * Handles GET requests to establish SSE streams for server→client messages.
 *
 * ## SSE Stream Contents
 *
 * The stream includes:
 * - Progress notifications (`notifications/progress`)
 * - Log notifications (`notifications/message`)
 * - Elicitation requests (`elicitation/create`)
 * - Sampling requests (`sampling/createMessage`)
 * - Final tool result (`tools/call` response)
 *
 * ## Resumability
 *
 * Per MCP spec, supports resumption via Last-Event-ID header:
 * 1. Each event has an ID based on session ID and LSN
 * 2. Client can reconnect with Last-Event-ID
 * 3. Server replays events from that point
 *
 * @packageDocumentation
 */
import { resource, type Operation, type Subscription } from 'effection'
import type { McpSseStreamRequest, McpSessionState } from './types'
import type { McpSessionManager } from './session-manager'
import {
  encodeSessionEvent,
  createEncoderContext,
} from '../protocol/message-encoder'
import {
  formatMessageAsSse,
  createPrimeEvent,
  createSseHeaders,
} from '../protocol/sse-formatter'
import type { JsonRpcId } from '../protocol/types'

// =============================================================================
// SSE STREAM OPTIONS
// =============================================================================

/**
 * Options for SSE streaming.
 */
export interface SseStreamOptions {
  /**
   * SSE retry interval in milliseconds.
   * Default: 1000
   */
  retryMs?: number | undefined

  /**
   * Logger name for log messages.
   */
  logger?: string | undefined
}

// =============================================================================
// SSE EVENT STREAM
// =============================================================================

/**
 * Create an SSE event subscription from a tool session.
 *
 * Transforms ToolSessionEvents into SSE-formatted strings.
 */
export function createSseEventStream(
  state: McpSessionState,
  manager: McpSessionManager,
  options: SseStreamOptions = {}
): Operation<Subscription<string, void>> {
  const { logger } = options
  const { session, sessionId, toolCallRequestId } = state

  return resource(function* (provide) {
    // Create encoder context
    const ctx = createEncoderContext(
      toolCallRequestId,
      `progress_${sessionId}`,
      logger
    )

    // Get event stream from session
    const afterLSN = state.lastLSN
    const eventSubscription = yield* session.events(afterLSN)

    let currentLSN = afterLSN

    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        const result = yield* eventSubscription.next()

        if (result.done) {
          return { done: true, value: undefined }
        }

        const event = result.value
        currentLSN = event.lsn
        manager.updateLastLSN(sessionId, currentLSN)

        // Encode event to MCP message
        const encoded = encodeSessionEvent(event, ctx)

        // Track pending requests for correlation
        if (encoded.type === 'request') {
          if (encoded.elicitId) {
            const elicitEvent = event as { key?: string }
            manager.registerPendingElicit(
              sessionId,
              encoded.elicitId,
              (encoded.message as { id: JsonRpcId }).id,
              elicitEvent.key ?? 'unknown'
            )
          }
          if (encoded.sampleId) {
            manager.registerPendingSample(
              sessionId,
              encoded.sampleId,
              (encoded.message as { id: JsonRpcId }).id
            )
          }
        }

        // Format as SSE
        const sseString = formatMessageAsSse(encoded.message, sessionId, currentLSN)
        return { done: false, value: sseString }
      },
    })
  })
}

// =============================================================================
// GET HANDLER
// =============================================================================

/**
 * Handle a GET request for SSE streaming.
 *
 * @returns An Operation that resolves to a Response with SSE stream
 */
export function* handleGet(
  request: McpSseStreamRequest,
  manager: McpSessionManager,
  options: SseStreamOptions = {}
): Operation<Response> {
  const { sessionId, afterLSN } = request
  const { retryMs = 1000 } = options

  // Acquire session
  const state = yield* manager.acquireSession(sessionId)

  // Update starting LSN if client is resuming
  if (afterLSN !== undefined) {
    state.lastLSN = afterLSN
  }

  // Create SSE subscription
  const sseSubscription = yield* createSseEventStream(state, manager, options)

  // Build response headers
  const headers = new Headers(createSseHeaders())
  headers.set('Mcp-Session-Id', sessionId)

  // Create the ReadableStream
  const encoder = new TextEncoder()
  let released = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Send prime event per MCP spec
      const primeEvent = createPrimeEvent(sessionId, retryMs)
      controller.enqueue(encoder.encode(primeEvent))
    },

    async pull(controller) {
      try {
        // This is awkward - we need to run the Effection generator
        // In a real implementation, we'd use scope.run()
        // For now, we'll inline the logic
        const result = await runSubscriptionNext(sseSubscription)

        if (result.done) {
          controller.close()
          if (!released) {
            released = true
            // Note: Can't easily run Effection operation here
            // Would need scope reference
          }
        } else {
          controller.enqueue(encoder.encode(result.value))
        }
      } catch (error) {
        controller.error(error)
        if (!released) {
          released = true
        }
      }
    },

    async cancel() {
      if (!released) {
        released = true
        // Note: Would release session here with scope.run()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers,
  })
}

// =============================================================================
// HELPER: RUN SUBSCRIPTION
// =============================================================================

/**
 * Run a subscription's next() operation.
 *
 * NOTE: This is a simplified implementation. In production, this would
 * use scope.run() to properly execute the Effection Operation.
 */
async function runSubscriptionNext<T>(
  _subscription: Subscription<T, void>
): Promise<IteratorResult<T, void>> {
  // This is a placeholder - in the real implementation,
  // the mcp-handler.ts will use createStreamingHandler which
  // properly manages the Effection scope
  throw new Error('Use createSseStreamHandler for proper Effection integration')
}

// =============================================================================
// STREAMING HANDLER INTEGRATION
// =============================================================================

/**
 * Create an SSE stream setup function for use with createStreamingHandler.
 *
 * This is the proper way to integrate with the streaming handler primitive.
 */
export function createSseStreamSetup(
  state: McpSessionState,
  manager: McpSessionManager,
  options: SseStreamOptions = {}
) {
  return function* (): Operation<Subscription<string, void>> {
    return yield* createSseEventStream(state, manager, options)
  }
}
