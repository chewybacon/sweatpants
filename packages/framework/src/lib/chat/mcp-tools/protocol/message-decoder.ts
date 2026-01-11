/**
 * MCP Message Decoder
 *
 * Decodes MCP JSON-RPC messages into tool session responses.
 *
 * ## Message Types
 *
 * This decoder handles incoming responses from the MCP client:
 *
 * | MCP Response             | Session Action                    |
 * |-------------------------|-----------------------------------|
 * | elicitation/create      | session.respondToElicit()         |
 * | sampling/createMessage  | session.respondToSample()         |
 *
 * @packageDocumentation
 */
import type {
  JsonRpcResponse,
  JsonRpcRequest,
  JsonRpcNotification,
  McpElicitationResult,
  McpCreateMessageResult,
  McpToolCallParams,
  McpContentBlock,
} from './types.ts'
import { isJsonRpcError, isJsonRpcSuccess, isTextContent, isToolUseContent } from './types.ts'
import type { 
  ElicitResult, 
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolCall,
} from '../mcp-tool-types.ts'

// =============================================================================
// DECODED TYPES
// =============================================================================

/**
 * Unified sample result type for decoded messages.
 */
export type DecodedSampleResult = SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls

/**
 * Result of decoding an MCP message.
 */
export type DecodedMessage =
  | { type: 'elicitation_response'; elicitId: string; result: ElicitResult<unknown> }
  | { type: 'sampling_response'; sampleId: string; result: DecodedSampleResult }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; requestId: string | number }
  | { type: 'error'; code: number; message: string; data?: unknown }
  | { type: 'unknown'; raw: unknown }

// =============================================================================
// ELICITATION DECODER
// =============================================================================

/**
 * Decode an MCP elicitation response into an ElicitResult.
 */
export function decodeElicitationResponse(
  response: JsonRpcResponse<McpElicitationResult>,
  elicitId: string
): DecodedMessage {
  if (isJsonRpcError(response)) {
    return {
      type: 'error',
      code: response.error.code,
      message: response.error.message,
      data: response.error.data,
    }
  }

  if (!isJsonRpcSuccess(response)) {
    return { type: 'unknown', raw: response }
  }

  const mcpResult = response.result

  // Map MCP action to our ElicitResult format
  let elicitResult: ElicitResult<unknown>

  switch (mcpResult.action) {
    case 'accept':
      elicitResult = {
        action: 'accept',
        content: mcpResult.content ?? {},
      }
      break
    case 'decline':
      elicitResult = {
        action: 'decline',
      }
      break
    case 'cancel':
      elicitResult = {
        action: 'cancel',
      }
      break
    default:
      return { type: 'unknown', raw: response }
  }

  return {
    type: 'elicitation_response',
    elicitId,
    result: elicitResult,
  }
}

// =============================================================================
// SAMPLING DECODER
// =============================================================================

/**
 * Extract text from MCP content blocks.
 */
function extractTextFromContent(content: McpContentBlock | McpContentBlock[]): string {
  const blocks = Array.isArray(content) ? content : [content]
  const textBlocks = blocks.filter(isTextContent)
  return textBlocks.map(b => b.text).join('\n')
}

/**
 * Extract tool calls from MCP content blocks.
 */
function extractToolCallsFromContent(content: McpContentBlock | McpContentBlock[]): SamplingToolCall[] {
  const blocks = Array.isArray(content) ? content : [content]
  const toolUseBlocks = blocks.filter(isToolUseContent)
  return toolUseBlocks.map(block => ({
    id: block.id,
    name: block.name,
    arguments: block.input,
  }))
}

/**
 * Decode an MCP sampling response into a SampleResult.
 * 
 * Returns different result types based on the response:
 * - If stopReason is 'toolUse', returns SampleResultWithToolCalls
 * - Otherwise returns SampleResultBase (structured output parsing happens at a higher layer)
 */
export function decodeSamplingResponse(
  response: JsonRpcResponse<McpCreateMessageResult>,
  sampleId: string
): DecodedMessage {
  if (isJsonRpcError(response)) {
    return {
      type: 'error',
      code: response.error.code,
      message: response.error.message,
      data: response.error.data,
    }
  }

  if (!isJsonRpcSuccess(response)) {
    return { type: 'unknown', raw: response }
  }

  const mcpResult = response.result

  // Extract text from content
  const text = extractTextFromContent(mcpResult.content)

  // Check if this is a tool use response
  if (mcpResult.stopReason === 'toolUse') {
    const toolCalls = extractToolCallsFromContent(mcpResult.content)
    const result: SampleResultWithToolCalls = {
      text,
      model: mcpResult.model,
      stopReason: 'toolUse',
      toolCalls,
    }
    return {
      type: 'sampling_response',
      sampleId,
      result,
    }
  }

  // Return base result (structured output parsing happens at runtime layer)
  const result: SampleResultBase = {
    text,
    model: mcpResult.model,
    ...(mcpResult.stopReason !== undefined && { stopReason: mcpResult.stopReason }),
  }

  return {
    type: 'sampling_response',
    sampleId,
    result,
  }
}

// =============================================================================
// TOOL CALL DECODER
// =============================================================================

/**
 * Decode an MCP tools/call request.
 */
export function decodeToolCallRequest(
  request: JsonRpcRequest<'tools/call', McpToolCallParams>
): DecodedMessage {
  return {
    type: 'tool_call',
    name: request.params?.name ?? '',
    args: request.params?.arguments ?? {},
    requestId: request.id,
  }
}

// =============================================================================
// GENERIC DECODER
// =============================================================================

/**
 * Pending response tracking for correlating responses with their requests.
 */
export interface PendingRequest {
  type: 'elicitation' | 'sampling'
  id: string // elicitId or sampleId
}

/**
 * Decoder context for tracking pending requests.
 */
export interface DecoderContext {
  /**
   * Map of JSON-RPC request ID to pending request info.
   */
  pendingRequests: Map<string | number, PendingRequest>

  /**
   * Add a pending elicitation request.
   */
  addPendingElicitation(requestId: string | number, elicitId: string): void

  /**
   * Add a pending sampling request.
   */
  addPendingSampling(requestId: string | number, sampleId: string): void
}

/**
 * Create a decoder context for tracking pending requests.
 */
export function createDecoderContext(): DecoderContext {
  const pendingRequests = new Map<string | number, PendingRequest>()

  return {
    pendingRequests,
    addPendingElicitation(requestId, elicitId) {
      pendingRequests.set(requestId, { type: 'elicitation', id: elicitId })
    },
    addPendingSampling(requestId, sampleId) {
      pendingRequests.set(requestId, { type: 'sampling', id: sampleId })
    },
  }
}

/**
 * Decode a JSON-RPC response using context to correlate with the original request.
 */
export function decodeResponse(
  response: JsonRpcResponse,
  ctx: DecoderContext
): DecodedMessage {
  const requestId = isJsonRpcSuccess(response) || isJsonRpcError(response)
    ? response.id
    : null

  if (requestId === null) {
    return { type: 'unknown', raw: response }
  }

  const pending = ctx.pendingRequests.get(requestId)
  if (!pending) {
    return { type: 'unknown', raw: response }
  }

  // Remove from pending
  ctx.pendingRequests.delete(requestId)

  switch (pending.type) {
    case 'elicitation':
      return decodeElicitationResponse(
        response as JsonRpcResponse<McpElicitationResult>,
        pending.id
      )
    case 'sampling':
      return decodeSamplingResponse(
        response as JsonRpcResponse<McpCreateMessageResult>,
        pending.id
      )
  }
}

// =============================================================================
// MESSAGE PARSING
// =============================================================================

/**
 * Parsed JSON-RPC message union type.
 */
export type ParsedJsonRpcMessage =
  | { type: 'request'; message: JsonRpcRequest }
  | { type: 'notification'; message: JsonRpcNotification }
  | { type: 'response'; message: JsonRpcResponse }
  | { type: 'invalid'; raw: unknown; error: string }

/**
 * Parse a raw JSON string into a typed JSON-RPC message.
 */
export function parseJsonRpcMessage(raw: string): ParsedJsonRpcMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { type: 'invalid', raw, error: 'Invalid JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { type: 'invalid', raw: parsed, error: 'Not an object' }
  }

  const obj = parsed as Record<string, unknown>

  if (obj['jsonrpc'] !== '2.0') {
    return { type: 'invalid', raw: parsed, error: 'Not JSON-RPC 2.0' }
  }

  // Check for response (has result or error)
  if ('result' in obj || 'error' in obj) {
    return { type: 'response', message: parsed as unknown as JsonRpcResponse }
  }

  // Check for request (has id and method)
  if ('id' in obj && 'method' in obj) {
    return { type: 'request', message: parsed as unknown as JsonRpcRequest }
  }

  // Check for notification (has method but no id)
  if ('method' in obj && !('id' in obj)) {
    return { type: 'notification', message: parsed as unknown as JsonRpcNotification }
  }

  return { type: 'invalid', raw: parsed, error: 'Unknown message type' }
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * Validate that a tools/call request has required fields.
 */
export function validateToolCallRequest(
  request: JsonRpcRequest
): request is JsonRpcRequest<'tools/call', McpToolCallParams> {
  if (request.method !== 'tools/call') return false
  if (!request.params) return false
  const params = request.params as Record<string, unknown>
  if (typeof params['name'] !== 'string') return false
  return true
}

/**
 * Validate that an elicitation response has required fields.
 */
export function validateElicitationResponse(
  response: JsonRpcResponse
): response is JsonRpcResponse<McpElicitationResult> {
  if (isJsonRpcError(response)) return true // Errors are valid responses
  if (!isJsonRpcSuccess(response)) return false
  const result = response.result as Record<string, unknown>
  if (!result['action']) return false
  if (!['accept', 'decline', 'cancel'].includes(result['action'] as string)) return false
  return true
}

/**
 * Validate that a sampling response has required fields.
 */
export function validateSamplingResponse(
  response: JsonRpcResponse
): response is JsonRpcResponse<McpCreateMessageResult> {
  if (isJsonRpcError(response)) return true // Errors are valid responses
  if (!isJsonRpcSuccess(response)) return false
  const result = response.result as Record<string, unknown>
  if (result['role'] !== 'assistant') return false
  if (!result['content']) return false
  return true
}
