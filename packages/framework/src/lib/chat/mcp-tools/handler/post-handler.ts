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
import type {
  McpToolsCallRequest,
  McpElicitResponse,
  McpSampleResponse,
  McpPostResult,
} from './types'
import type { McpSessionManager } from './session-manager'

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
 * Creates a new session and returns SSE stream type.
 * Tool execution is deferred until the SSE stream starts,
 * ensuring everything runs in the same Effection scope.
 * 
 * NOTE: We don't try to detect immediate completion here because
 * subscribing to events would start tool execution in this scope,
 * which would then be orphaned when this scope.run() returns.
 */
export function* handleToolsCall(
  request: McpToolsCallRequest,
  manager: McpSessionManager,
  _options: PostHandlerOptions = {}
): Operation<McpPostResult> {
  // Create new session (tool execution is deferred)
  const state = yield* manager.createSession(request)
  const { session, sessionId } = state

  // Always upgrade to SSE - tool execution will start when SSE stream begins
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
