/**
 * MCP Protocol Module
 *
 * Provides encoding/decoding between ToolSessionEvents and MCP JSON-RPC messages,
 * plus SSE formatting for the Streamable HTTP transport.
 *
 * ## Quick Start
 *
 * ```typescript
 * import {
 *   encodeSessionEvent,
 *   createEncoderContext,
 *   formatMessageAsSse,
 *   createSseHeaders,
 * } from '@grove/framework/mcp-tools/protocol'
 *
 * // Encode a session event as MCP JSON-RPC
 * const ctx = createEncoderContext(toolCallRequestId)
 * const encoded = encodeSessionEvent(event, ctx)
 *
 * // Format as SSE for streaming
 * const sse = formatMessageAsSse(encoded.message, sessionId, event.lsn)
 * ```
 *
 * ## MCP Mapping
 *
 * | ToolSessionEvent     | MCP Message                        |
 * |---------------------|-------------------------------------|
 * | progress            | notifications/progress              |
 * | log                 | notifications/message               |
 * | elicit_request      | elicitation/create request          |
 * | sample_request      | sampling/createMessage request      |
 * | result              | tools/call response (success)       |
 * | error               | tools/call response (error)         |
 * | cancelled           | tools/call response (error)         |
 *
 * @packageDocumentation
 */

// =============================================================================
// TYPES
// =============================================================================

export type {
  // JSON-RPC types
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcResponse,

  // MCP content types
  McpTextContent,
  McpImageContent,
  McpAudioContent,
  McpResourceContent,
  McpToolUseContent,
  McpToolResultContent,
  McpContentBlock,

  // MCP message types
  McpRole,
  McpMessage,

  // Sampling types
  McpModelPreferences,
  McpToolChoice,
  McpToolDefinition,
  McpStopReason,
  McpCreateMessageParams,
  McpCreateMessageResult,

  // Elicitation types
  McpElicitationMode,
  McpElicitationAction,
  McpElicitationParamsBase,
  McpFormElicitationParams,
  McpUrlElicitationParams,
  McpElicitationParams,
  McpElicitationResult,

  // Notification types
  McpProgressParams,
  McpLogLevel,
  McpMessageParams,
  McpElicitationCompleteParams,

  // Tool types
  McpToolCallParams,
  McpToolCallResult,

  // Request/response types
  McpSamplingRequest,
  McpSamplingResponse,
  McpElicitationRequest,
  McpElicitationResponse,
  McpToolCallRequest,
  McpToolCallResponse,
  McpProgressNotification,
  McpMessageNotification,
  McpElicitationCompleteNotification,

  // SSE types
  SseEvent,
} from './types'

// Error codes
export { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES } from './types'

// Type guards
export {
  isJsonRpcError,
  isJsonRpcSuccess,
  isTextContent,
  isToolUseContent,
  isToolResultContent,
} from './types'

// =============================================================================
// ENCODER
// =============================================================================

export type {
  EncoderContext,
  EncodedMessage,
} from './message-encoder'

export {
  // Individual encoders
  encodeProgressNotification,
  encodeLogNotification,
  encodeElicitationRequest,
  encodeSamplingRequest,
  encodeToolCallResult,
  encodeToolCallError,
  encodeToolCallCancelled,

  // Unified encoder
  encodeSessionEvent,

  // Helpers
  createEncoderContext,
} from './message-encoder'

// =============================================================================
// DECODER
// =============================================================================

export type {
  DecodedMessage,
  PendingRequest,
  DecoderContext,
  ParsedJsonRpcMessage,
} from './message-decoder'

export {
  // Individual decoders
  decodeElicitationResponse,
  decodeSamplingResponse,
  decodeToolCallRequest,

  // Generic decoder
  decodeResponse,

  // Context
  createDecoderContext,

  // Parsing
  parseJsonRpcMessage,

  // Validation
  validateToolCallRequest,
  validateElicitationResponse,
  validateSamplingResponse,
} from './message-decoder'

// =============================================================================
// SSE FORMATTER
// =============================================================================

export type { SseWriter } from './sse-formatter'

export {
  // Event ID handling
  generateEventId,
  parseEventId,

  // SSE formatting
  formatSseEvent,
  formatMessageAsSse,

  // Stream control
  createPrimeEvent,
  createCloseEvent,

  // SSE parsing (for testing/clients)
  parseSseEvent,
  parseSseChunk,

  // Stream helpers
  createSseHeaders,
  createSseWriter,
} from './sse-formatter'
