/**
 * MCP Protocol Types
 *
 * Type definitions for MCP (Model Context Protocol) messages.
 * These types follow the MCP spec 2025-11-25.
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25
 * @packageDocumentation
 */

// =============================================================================
// JSON-RPC BASE TYPES
// =============================================================================

/**
 * JSON-RPC request ID.
 */
export type JsonRpcId = string | number

/**
 * Base JSON-RPC message.
 */
export interface JsonRpcMessage {
  jsonrpc: '2.0'
}

/**
 * JSON-RPC request.
 */
export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown>
  extends JsonRpcMessage {
  id: JsonRpcId
  method: TMethod
  params?: TParams
}

/**
 * JSON-RPC notification (request without id).
 */
export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown>
  extends JsonRpcMessage {
  method: TMethod
  params?: TParams
}

/**
 * JSON-RPC success response.
 */
export interface JsonRpcSuccessResponse<TResult = unknown> extends JsonRpcMessage {
  id: JsonRpcId
  result: TResult
}

/**
 * JSON-RPC error object.
 */
export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

/**
 * JSON-RPC error response.
 */
export interface JsonRpcErrorResponse extends JsonRpcMessage {
  id: JsonRpcId | null
  error: JsonRpcError
}

/**
 * Any JSON-RPC response.
 */
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse

// =============================================================================
// MCP ERROR CODES
// =============================================================================

/**
 * Standard JSON-RPC error codes.
 */
export const JSON_RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const

/**
 * MCP-specific error codes.
 */
export const MCP_ERROR_CODES = {
  /** User rejected the request (e.g., sampling or elicitation) */
  USER_REJECTED: -1,
  /** URL elicitation required before proceeding */
  URL_ELICITATION_REQUIRED: -32042,
} as const

// =============================================================================
// MCP CONTENT TYPES
// =============================================================================

/**
 * Text content in an MCP message.
 */
export interface McpTextContent {
  type: 'text'
  text: string
}

/**
 * Image content in an MCP message.
 */
export interface McpImageContent {
  type: 'image'
  data: string // base64
  mimeType: string
}

/**
 * Audio content in an MCP message.
 */
export interface McpAudioContent {
  type: 'audio'
  data: string // base64
  mimeType: string
}

/**
 * Resource content in an MCP message.
 */
export interface McpResourceContent {
  type: 'resource'
  resource: {
    uri: string
    text?: string
    blob?: string // base64
    mimeType?: string
  }
}

/**
 * Tool use content (assistant requesting a tool call).
 */
export interface McpToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

/**
 * Tool result content (response to tool use).
 */
export interface McpToolResultContent {
  type: 'tool_result'
  toolUseId: string
  content: McpContentBlock[]
  isError?: boolean
}

/**
 * Any content block in an MCP message.
 */
export type McpContentBlock =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpResourceContent
  | McpToolUseContent
  | McpToolResultContent

// =============================================================================
// MCP MESSAGE TYPES
// =============================================================================

/**
 * Role in an MCP conversation.
 */
export type McpRole = 'user' | 'assistant'

/**
 * A message in an MCP conversation.
 */
export interface McpMessage {
  role: McpRole
  content: McpContentBlock | McpContentBlock[]
}

// =============================================================================
// SAMPLING TYPES
// =============================================================================

/**
 * Model preferences for sampling.
 */
export interface McpModelPreferences {
  hints?: Array<{ name: string }>
  costPriority?: number
  speedPriority?: number
  intelligencePriority?: number
}

/**
 * Tool choice configuration.
 */
export interface McpToolChoice {
  mode: 'auto' | 'required' | 'none'
}

/**
 * Tool definition for sampling.
 */
export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Stop reason for sampling response.
 */
export type McpStopReason = 'endTurn' | 'toolUse' | 'maxTokens' | 'stopSequence'

/**
 * Parameters for sampling/createMessage request.
 */
export interface McpCreateMessageParams {
  messages: McpMessage[]
  modelPreferences?: McpModelPreferences
  systemPrompt?: string
  includeContext?: 'none' | 'thisServer' | 'allServers'
  temperature?: number
  maxTokens: number
  stopSequences?: string[]
  metadata?: Record<string, unknown>
  tools?: McpToolDefinition[]
  toolChoice?: McpToolChoice
}

/**
 * Result of sampling/createMessage.
 */
export interface McpCreateMessageResult {
  role: 'assistant'
  content: McpContentBlock | McpContentBlock[]
  model: string
  stopReason?: McpStopReason
}

// =============================================================================
// ELICITATION TYPES
// =============================================================================

/**
 * Mode of elicitation.
 */
export type McpElicitationMode = 'form' | 'url'

/**
 * Response action for elicitation.
 */
export type McpElicitationAction = 'accept' | 'decline' | 'cancel'

/**
 * Base parameters for elicitation/create request.
 */
export interface McpElicitationParamsBase {
  mode?: McpElicitationMode
  message: string
}

/**
 * Form mode elicitation parameters.
 */
export interface McpFormElicitationParams extends McpElicitationParamsBase {
  mode?: 'form'
  requestedSchema: Record<string, unknown>
}

/**
 * URL mode elicitation parameters.
 */
export interface McpUrlElicitationParams extends McpElicitationParamsBase {
  mode: 'url'
  elicitationId: string
  url: string
}

/**
 * Parameters for elicitation/create request.
 */
export type McpElicitationParams = McpFormElicitationParams | McpUrlElicitationParams

/**
 * Result of elicitation/create.
 */
export interface McpElicitationResult {
  action: McpElicitationAction
  content?: Record<string, unknown>
}

// =============================================================================
// NOTIFICATION TYPES
// =============================================================================

/**
 * Progress notification parameters.
 */
export interface McpProgressParams {
  progressToken: string | number
  progress: number
  total?: number
  message?: string
}

/**
 * Log level for message notifications.
 */
export type McpLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency'

/**
 * Message notification parameters (logging).
 */
export interface McpMessageParams {
  level: McpLogLevel
  logger?: string
  data: unknown
}

/**
 * Elicitation complete notification parameters.
 */
export interface McpElicitationCompleteParams {
  elicitationId: string
}

// =============================================================================
// TOOL TYPES
// =============================================================================

/**
 * Parameters for tools/call request.
 */
export interface McpToolCallParams {
  name: string
  arguments?: Record<string, unknown>
}

/**
 * Result of tools/call.
 */
export interface McpToolCallResult {
  content: McpContentBlock[]
  isError?: boolean
}

// =============================================================================
// REQUEST/RESPONSE TYPES
// =============================================================================

/**
 * MCP request for sampling/createMessage.
 */
export type McpSamplingRequest = JsonRpcRequest<'sampling/createMessage', McpCreateMessageParams>

/**
 * MCP response for sampling/createMessage.
 */
export type McpSamplingResponse = JsonRpcResponse<McpCreateMessageResult>

/**
 * MCP request for elicitation/create.
 */
export type McpElicitationRequest = JsonRpcRequest<'elicitation/create', McpElicitationParams>

/**
 * MCP response for elicitation/create.
 */
export type McpElicitationResponse = JsonRpcResponse<McpElicitationResult>

/**
 * MCP request for tools/call.
 */
export type McpToolCallRequest = JsonRpcRequest<'tools/call', McpToolCallParams>

/**
 * MCP response for tools/call.
 */
export type McpToolCallResponse = JsonRpcResponse<McpToolCallResult>

/**
 * MCP progress notification.
 */
export type McpProgressNotification = JsonRpcNotification<'notifications/progress', McpProgressParams>

/**
 * MCP message notification (logging).
 */
export type McpMessageNotification = JsonRpcNotification<'notifications/message', McpMessageParams>

/**
 * MCP elicitation complete notification.
 */
export type McpElicitationCompleteNotification = JsonRpcNotification<
  'notifications/elicitation/complete',
  McpElicitationCompleteParams
>

// =============================================================================
// SSE TYPES
// =============================================================================

/**
 * Server-Sent Event structure.
 */
export interface SseEvent {
  /** Event ID for resumability */
  id?: string
  /** Event type (defaults to 'message') */
  event?: string
  /** Event data (JSON stringified) */
  data: string
  /** Retry interval in milliseconds */
  retry?: number
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if a JSON-RPC response is an error.
 */
export function isJsonRpcError(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return 'error' in response
}

/**
 * Check if a JSON-RPC response is a success.
 */
export function isJsonRpcSuccess<T>(response: JsonRpcResponse<T>): response is JsonRpcSuccessResponse<T> {
  return 'result' in response
}

/**
 * Check if content is text content.
 */
export function isTextContent(content: McpContentBlock): content is McpTextContent {
  return content.type === 'text'
}

/**
 * Check if content is tool use content.
 */
export function isToolUseContent(content: McpContentBlock): content is McpToolUseContent {
  return content.type === 'tool_use'
}

/**
 * Check if content is tool result content.
 */
export function isToolResultContent(content: McpContentBlock): content is McpToolResultContent {
  return content.type === 'tool_result'
}
