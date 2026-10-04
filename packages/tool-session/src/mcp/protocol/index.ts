/** MCP message codecs and request-scoped SSE helpers. */

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
} from "./types.ts";

// Error codes
export { JSON_RPC_ERROR_CODES, MCP_ERROR_CODES } from "./types.ts";

// Type guards
export {
  isJsonRpcError,
  isJsonRpcSuccess,
  isTextContent,
  isToolUseContent,
  isToolResultContent,
} from "./types.ts";

// =============================================================================
// ENCODER
// =============================================================================

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

  // Helpers
} from "./message-encoder.ts";

// =============================================================================
// DECODER
// =============================================================================

export type {
  DecodedMessage,
  PendingRequest,
  DecoderContext,
  ParsedJsonRpcMessage,
} from "./message-decoder.ts";

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
  MCP_MAX_MESSAGE_BYTES,
  parseJsonRpcMessage,
} from "./message-decoder.ts";

// =============================================================================
// SSE FORMATTER
// =============================================================================

export {
  // Event ID handling

  // SSE formatting
  formatSseEvent,
  formatMessageAsSse,

  // Stream control

  // SSE parsing (for testing/clients)
  parseSseEvent,
  parseSseChunk,

  // Stream helpers
  createSseHeaders,
} from "./sse-formatter.ts";
