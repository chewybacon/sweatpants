/**
 * MCP Request Parser
 *
 * Parses and classifies incoming MCP HTTP requests.
 *
 * ## Request Types
 *
 * 1. **POST with tools/call** - Start a new tool execution
 * 2. **POST with elicitation response** - Response to elicitation request
 * 3. **POST with sampling response** - Response to sampling request
 * 4. **GET** - Establish SSE stream for server→client messages
 * 5. **DELETE** - Terminate a session
 *
 * ## Headers
 *
 * - `Mcp-Session-Id` - Session identifier
 * - `Last-Event-ID` - Last received event ID (for resumability)
 * - `Accept` - Must include `text/event-stream` for GET
 * - `Content-Type` - Must be `application/json` for POST
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import { call } from 'effection'
import type {
  McpParsedRequest,
  McpRequestHeaders,
  McpHttpMethod,
  McpClassifiedRequest,
  McpToolsCallRequest,
  McpElicitResponse,
  McpSampleResponse,
  McpSseStreamRequest,
  McpTerminateRequest,
  McpInitializeRequest,
  McpToolsListRequest,
  McpPingRequest,
  McpNotification,
} from './types'
import { McpHandlerError, MCP_HANDLER_ERRORS } from './types'
import { parseEventId } from '../protocol/sse-formatter'
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpToolCallParams,
  McpElicitationResult,
  McpCreateMessageResult,
} from '../protocol/types'

// =============================================================================
// HEADER PARSING
// =============================================================================

/**
 * Parse MCP-relevant headers from a request.
 */
export function parseHeaders(request: Request): McpRequestHeaders {
  const sessionId = request.headers.get('Mcp-Session-Id')
  const lastEventId = request.headers.get('Last-Event-ID')
  const accept = request.headers.get('Accept')
  const contentType = request.headers.get('Content-Type')

  return {
    ...(sessionId != null && { sessionId }),
    ...(lastEventId != null && { lastEventId }),
    ...(accept != null && { accept }),
    ...(contentType != null && { contentType }),
  }
}

/**
 * Validate headers for a POST request.
 */
export function validatePostHeaders(headers: McpRequestHeaders): void {
  if (headers.contentType && !headers.contentType.includes('application/json')) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      'POST requests must have Content-Type: application/json',
      415 // Unsupported Media Type
    )
  }
}

/**
 * Validate headers for a GET request.
 */
export function validateGetHeaders(headers: McpRequestHeaders): void {
  if (!headers.accept?.includes('text/event-stream')) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.NOT_ACCEPTABLE,
      'GET requests must Accept: text/event-stream',
      406 // Not Acceptable
    )
  }
}

// =============================================================================
// REQUEST PARSING
// =============================================================================

/**
 * Parse an incoming HTTP request.
 */
export function* parseRequest(request: Request): Operation<McpParsedRequest> {
  const method = request.method.toUpperCase() as McpHttpMethod

  // Validate method
  if (!['GET', 'POST', 'DELETE'].includes(method)) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.METHOD_NOT_ALLOWED,
      `Method ${method} not allowed`,
      405
    )
  }

  const headers = parseHeaders(request)

  // Parse body for POST
  let body: unknown
  if (method === 'POST') {
    validatePostHeaders(headers)
    try {
      body = yield* call(() => request.json())
    } catch {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.INVALID_REQUEST,
        'Invalid JSON in request body',
        400
      )
    }
  }

  // Validate GET headers
  if (method === 'GET') {
    validateGetHeaders(headers)
  }

  return {
    method,
    headers,
    body,
    originalRequest: request,
  }
}

// =============================================================================
// JSON-RPC VALIDATION
// =============================================================================

/**
 * Check if a value is a valid JSON-RPC request.
 */
function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    obj['jsonrpc'] === '2.0' &&
    obj['id'] !== undefined &&
    typeof obj['method'] === 'string'
  )
}

/**
 * Check if a value is a valid JSON-RPC notification (request without id).
 */
function isJsonRpcNotification(value: unknown): value is { jsonrpc: '2.0'; method: string; params?: unknown } {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    obj['jsonrpc'] === '2.0' &&
    obj['id'] === undefined &&
    typeof obj['method'] === 'string'
  )
}

/**
 * Check if a value is a valid JSON-RPC response.
 */
function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    obj['jsonrpc'] === '2.0' &&
    obj['id'] !== undefined &&
    ('result' in obj || 'error' in obj)
  )
}

// =============================================================================
// REQUEST CLASSIFICATION
// =============================================================================

/**
 * Classify a POST request body as tools/call, elicit response, or sample response.
 */
function classifyPostBody(
  body: unknown,
  sessionId: string | undefined
): McpToolsCallRequest | McpElicitResponse | McpSampleResponse | McpInitializeRequest | McpToolsListRequest | McpPingRequest | McpNotification {
  // Check for JSON-RPC notification (no id - fire and forget)
  if (isJsonRpcNotification(body)) {
    const notif = body as { method: string; params?: unknown }
    return {
      type: 'notification',
      method: notif.method,
      params: notif.params,
    }
  }

  // Check for JSON-RPC request (tools/call, initialize, tools/list)
  if (isJsonRpcRequest(body)) {
    const req = body as JsonRpcRequest

    if (req.method === 'ping') {
      return {
        type: 'ping',
        requestId: req.id,
      }
    }

    if (req.method === 'initialize') {
      const params = req.params as {
        protocolVersion?: string
        capabilities?: Record<string, unknown>
        clientInfo?: { name: string; version: string }
      } | undefined

      return {
        type: 'initialize',
        requestId: req.id,
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: params?.capabilities ?? {},
        clientInfo: params?.clientInfo ?? { name: 'unknown', version: '0.0.0' },
      }
    }

    if (req.method === 'tools/list') {
      return {
        type: 'tools_list',
        requestId: req.id,
      }
    }

    if (req.method === 'tools/call') {
      const params = req.params as McpToolCallParams | undefined
      if (!params || typeof params.name !== 'string') {
        throw new McpHandlerError(
          MCP_HANDLER_ERRORS.INVALID_REQUEST,
          'tools/call requires params.name',
          400
        )
      }

      const result: McpToolsCallRequest = {
        type: 'tools_call',
        requestId: req.id,
        toolName: params.name,
        arguments: params.arguments ?? {},
      }
      if (sessionId !== undefined) {
        result.sessionId = sessionId
      }
      return result
    }

    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      `Unsupported request method: ${req.method}`,
      400
    )
  }

  // Check for JSON-RPC response (elicit or sample response)
  if (isJsonRpcResponse(body)) {
    const resp = body as JsonRpcResponse

    // Must have a session for responses
    if (!sessionId) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_REQUIRED,
        'Session ID required for responses',
        400
      )
    }

    // Check for error response
    if ('error' in resp) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.INVALID_REQUEST,
        'Error responses not supported',
        400
      )
    }

    const result = (resp as { result: unknown }).result

    // Try to classify as elicitation response
    if (isElicitationResult(result)) {
      const elicitResult: McpElicitResponse = {
        type: 'elicit_response',
        requestId: resp.id,
        elicitId: String(resp.id), // Correlate by request ID
        action: result.action,
        sessionId,
      }
      if (result.content !== undefined) {
        elicitResult.content = result.content
      }
      return elicitResult
    }

    // Try to classify as sampling response
    if (isSamplingResult(result)) {
      const sampleResult: McpSampleResponse = {
        type: 'sample_response',
        requestId: resp.id,
        sampleId: String(resp.id), // Correlate by request ID
        role: result.role,
        content: result.content,
        model: result.model,
        sessionId,
      }
      if (result.stopReason !== undefined) {
        sampleResult.stopReason = result.stopReason
      }
      return sampleResult
    }

    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      'Unrecognized response format',
      400
    )
  }

  throw new McpHandlerError(
    MCP_HANDLER_ERRORS.INVALID_REQUEST,
    'Request body must be a JSON-RPC request or response',
    400
  )
}

/**
 * Check if a result looks like an elicitation result.
 */
function isElicitationResult(result: unknown): result is McpElicitationResult {
  if (typeof result !== 'object' || result === null) return false
  const obj = result as Record<string, unknown>
  const action = obj['action']
  return (
    typeof action === 'string' &&
    ['accept', 'decline', 'cancel'].includes(action)
  )
}

/**
 * Check if a result looks like a sampling result.
 */
function isSamplingResult(result: unknown): result is McpCreateMessageResult {
  if (typeof result !== 'object' || result === null) return false
  const obj = result as Record<string, unknown>
  return (
    obj['role'] === 'assistant' &&
    obj['content'] !== undefined &&
    typeof obj['model'] === 'string'
  )
}

/**
 * Classify a GET request for SSE streaming.
 */
function classifyGetRequest(headers: McpRequestHeaders): McpSseStreamRequest {
  // Session ID may be omitted for initial SSE connection after initialize
  // If omitted, we'll return an idle stream that waits for tool calls
  if (!headers.sessionId) {
    // Return a special "no session" request that will create an idle stream
    return {
      type: 'sse_stream',
      sessionId: '', // Empty = idle stream
    }
  }

  // Parse Last-Event-ID for resumability
  let afterLSN: number | undefined
  if (headers.lastEventId) {
    const parsed = parseEventId(headers.lastEventId)
    if (parsed && parsed.sessionId === headers.sessionId) {
      afterLSN = parsed.lsn
    }
  }

  const result: McpSseStreamRequest = {
    type: 'sse_stream',
    sessionId: headers.sessionId,
  }
  if (afterLSN !== undefined) {
    result.afterLSN = afterLSN
  }
  return result
}

/**
 * Classify a DELETE request for session termination.
 */
function classifyDeleteRequest(headers: McpRequestHeaders): McpTerminateRequest {
  if (!headers.sessionId) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.SESSION_REQUIRED,
      'Mcp-Session-Id header required for session termination',
      400
    )
  }

  return {
    type: 'terminate',
    sessionId: headers.sessionId,
  }
}

// =============================================================================
// MAIN CLASSIFIER
// =============================================================================

/**
 * Classify a parsed MCP request.
 */
export function classifyRequest(parsed: McpParsedRequest): McpClassifiedRequest {
  switch (parsed.method) {
    case 'POST':
      return classifyPostBody(parsed.body, parsed.headers.sessionId)

    case 'GET':
      return classifyGetRequest(parsed.headers)

    case 'DELETE':
      return classifyDeleteRequest(parsed.headers)
  }
}

/**
 * Parse and classify an incoming request in one step.
 */
export function* parseAndClassify(request: Request): Operation<McpClassifiedRequest> {
  const parsed = yield* parseRequest(request)
  return classifyRequest(parsed)
}
