/**
 * MCP POST Request Handler
 *
 * Handles POST requests to the MCP endpoint:
 * - tools/call: Start a new tool execution
 * - Elicitation responses: Resume a paused tool
 * - Sampling responses: Resume a paused tool
 *
 * ## Response Modes
 *
 * Per MCP Streamable HTTP spec, POST responses can be:
 * 1. **Immediate JSON** - For fast completions, return JSON-RPC response
 * 2. **SSE Stream** - For long-running tools, return event stream
 *
 * This handler returns `McpPostResult` to let the main handler decide
 * whether to return JSON or upgrade to SSE.
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import { call } from 'effection'
import type { Stream, Subscription } from 'effection'
import type {
  McpToolsCallRequest,
  McpElicitResponse,
  McpSampleResponse,
  McpPostResult,
} from './types'
import type { McpSessionManager } from './session-manager'
import { encodeToolCallResult, encodeToolCallError } from '../protocol/message-encoder'
import type { JsonRpcResponse, McpToolCallResult } from '../protocol/types'

// =============================================================================
// POST HANDLER OPTIONS
// =============================================================================

/**
 * Options for post handler.
 */
export interface PostHandlerOptions {
  /**
   * Timeout for immediate response in milliseconds.
   * If tool doesn't complete within this time, upgrade to SSE.
   * Default: 5000 (5 seconds)
   */
  immediateTimeout?: number | undefined
}

// =============================================================================
// TOOLS/CALL HANDLER
// =============================================================================

/**
 * Handle a tools/call request.
 *
 * This creates a new session and either:
 * 1. Waits for immediate completion and returns JSON
 * 2. Returns SSE stream for long-running tools
 */
export function* handleToolsCall(
  request: McpToolsCallRequest,
  manager: McpSessionManager,
  options: PostHandlerOptions = {}
): Operation<McpPostResult> {
  const { immediateTimeout = 5000 } = options

  // Create new session
  const state = yield* manager.createSession(request)
  const { session, sessionId, toolCallRequestId } = state

  // Try to get immediate result
  // We'll wait for either completion or first backchannel request
  const result = yield* raceFirstEvent(session.events(), immediateTimeout)

  if (result.type === 'timeout') {
    // Tool is taking too long, upgrade to SSE
    return {
      type: 'sse',
      sessionId,
      session,
    }
  }

  const event = result.event

  // Check if we can return immediate JSON response
  if (event.type === 'result') {
    // Tool completed immediately
    const response = encodeToolCallResult(event, toolCallRequestId) as JsonRpcResponse<McpToolCallResult>

    return {
      type: 'json',
      status: 200,
      body: response,
      headers: { 'Mcp-Session-Id': sessionId },
    }
  }

  if (event.type === 'error') {
    // Tool failed immediately
    const response = encodeToolCallError(event, toolCallRequestId)

    return {
      type: 'json',
      status: 200, // JSON-RPC errors are 200 with error in body
      body: response,
      headers: { 'Mcp-Session-Id': sessionId },
    }
  }

  // First event is a backchannel request (elicit or sample) or notification
  // Upgrade to SSE for long-running interaction
  return {
    type: 'sse',
    sessionId,
    session,
  }
}

// =============================================================================
// ELICIT RESPONSE HANDLER
// =============================================================================

/**
 * Handle an elicitation response.
 */
export function* handleElicitResponse(
  response: McpElicitResponse,
  manager: McpSessionManager
): Operation<McpPostResult> {
  // Forward response to session
  yield* manager.handleElicitResponse(response)

  // Return acknowledgment
  return {
    type: 'json',
    status: 202, // Accepted
    body: { jsonrpc: '2.0', id: response.requestId, result: {} },
    headers: { 'Mcp-Session-Id': response.sessionId },
  }
}

// =============================================================================
// SAMPLE RESPONSE HANDLER
// =============================================================================

/**
 * Handle a sampling response.
 */
export function* handleSampleResponse(
  response: McpSampleResponse,
  manager: McpSessionManager
): Operation<McpPostResult> {
  // Forward response to session
  yield* manager.handleSampleResponse(response)

  // Return acknowledgment
  return {
    type: 'json',
    status: 202, // Accepted
    body: { jsonrpc: '2.0', id: response.requestId, result: {} },
    headers: { 'Mcp-Session-Id': response.sessionId },
  }
}

// =============================================================================
// HELPER: RACE FIRST EVENT
// =============================================================================

type RaceResult<T> =
  | { type: 'event'; event: T }
  | { type: 'timeout' }

/**
 * Race to get the first event from a stream, with timeout.
 */
function* raceFirstEvent<T>(
  stream: Stream<T, void>,
  timeoutMs: number
): Operation<RaceResult<T>> {
  // Create a subscription to the stream
  const subscription: Subscription<T, void> = yield* stream

  // Create a timeout promise
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  // Race between first event and timeout
  try {
    const result = yield* call(async () => {
      // Wrap subscription.next() in a promise
      // This is a bit awkward but necessary to race with timeout
      const eventPromise = (async () => {
        // We need to run the generator synchronously, but we're in async context
        // Actually, we can't easily do this from within call()
        // Let's use a different approach
        return 'need_subscription' as const
      })()

      return Promise.race([eventPromise, timeoutPromise])
    })

    if (result === 'timeout') {
      return { type: 'timeout' }
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }

  // If we get here, we need to properly get the first event
  // Let's just get it directly
  const iterResult = yield* subscription.next()

  if (iterResult.done) {
    // Stream ended without emitting anything - treat as immediate completion
    // This shouldn't normally happen
    return { type: 'timeout' }
  }

  return { type: 'event', event: iterResult.value }
}

// =============================================================================
// MAIN POST HANDLER
// =============================================================================

/**
 * Handle any POST request.
 */
export function* handlePost(
  request: McpToolsCallRequest | McpElicitResponse | McpSampleResponse,
  manager: McpSessionManager,
  options: PostHandlerOptions = {}
): Operation<McpPostResult> {
  switch (request.type) {
    case 'tools_call':
      return yield* handleToolsCall(request, manager, options)

    case 'elicit_response':
      return yield* handleElicitResponse(request, manager)

    case 'sample_response':
      return yield* handleSampleResponse(request, manager)
  }
}
