/**
 * MCP Message Encoder
 *
 * Encodes ToolSessionEvents into MCP JSON-RPC messages.
 *
 * ## Mapping
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
import type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcId,
  McpProgressParams,
  McpMessageParams,
  McpElicitationParams,
  McpCreateMessageParams,
  McpToolCallResult,
  McpLogLevel,
  McpTextContent,
  McpMessage,
  McpRole,
  McpToolDefinition,
  McpToolChoice,
} from './types.ts'
import type {
  ToolSessionEvent,
  ProgressEvent,
  LogEvent,
  ElicitRequestEvent,
  SampleRequestEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
} from '../session/types.ts'
import type { LogLevel as ToolLogLevel } from '../mcp-tool-types.ts'

// =============================================================================
// LOG LEVEL MAPPING
// =============================================================================

/**
 * Map internal log levels to MCP log levels.
 * Our internal LogLevel is simpler than MCP's full range.
 */
function mapLogLevel(level: ToolLogLevel): McpLogLevel {
  switch (level) {
    case 'debug':
      return 'debug'
    case 'info':
      return 'info'
    case 'warning':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'info'
  }
}

// =============================================================================
// NOTIFICATION ENCODERS
// =============================================================================

/**
 * Encode a progress event as an MCP progress notification.
 */
export function encodeProgressNotification(
  event: ProgressEvent,
  progressToken: string | number
): JsonRpcNotification<'notifications/progress', McpProgressParams> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progressToken,
      progress: event.progress ?? 0,
      total: 1,
      message: event.message,
    },
  }
}

/**
 * Encode a log event as an MCP message notification.
 */
export function encodeLogNotification(
  event: LogEvent,
  logger?: string
): JsonRpcNotification<'notifications/message', McpMessageParams> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: {
      level: mapLogLevel(event.level),
      ...(logger !== undefined && { logger }),
      data: event.message,
    },
  }
}

// =============================================================================
// REQUEST ENCODERS
// =============================================================================

/**
 * Encode an elicit request event as an MCP elicitation/create request.
 */
export function encodeElicitationRequest(
  event: ElicitRequestEvent,
  requestId: JsonRpcId
): JsonRpcRequest<'elicitation/create', McpElicitationParams> {
  return {
    jsonrpc: '2.0',
    id: requestId,
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message: event.message,
      requestedSchema: event.schema,
    },
  }
}

/**
 * Encode a sample request event as an MCP sampling/createMessage request.
 */
export function encodeSamplingRequest(
  event: SampleRequestEvent,
  requestId: JsonRpcId
): JsonRpcRequest<'sampling/createMessage', McpCreateMessageParams> {
  // Convert internal messages to MCP messages
  // Filter out system messages (MCP uses systemPrompt field instead)
  const mcpMessages: McpMessage[] = event.messages
    .filter(msg => msg.role !== 'system')
    .map(msg => ({
      role: msg.role as McpRole,
      content: {
        type: 'text',
        text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      } as McpTextContent,
    }))

  // Build MCP tools from our tool definitions
  const mcpTools: McpToolDefinition[] | undefined = event.tools?.map(tool => ({
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))

  // Build MCP tool choice
  const mcpToolChoice: McpToolChoice | undefined = event.toolChoice
    ? { mode: event.toolChoice }
    : undefined

  return {
    jsonrpc: '2.0',
    id: requestId,
    method: 'sampling/createMessage',
    params: {
      messages: mcpMessages,
      ...(event.systemPrompt !== undefined && { systemPrompt: event.systemPrompt }),
      maxTokens: event.maxTokens ?? 4096,
      ...(mcpTools !== undefined && mcpTools.length > 0 && { tools: mcpTools }),
      ...(mcpToolChoice !== undefined && { toolChoice: mcpToolChoice }),
      // Note: schema is passed through as-is (already converted from Zod to JSON Schema)
      ...(event.schema !== undefined && { metadata: { responseSchema: event.schema } }),
    },
  }
}

// =============================================================================
// RESPONSE ENCODERS
// =============================================================================

/**
 * Encode a result event as an MCP tools/call response.
 */
export function encodeToolCallResult<TResult>(
  event: ResultEvent<TResult>,
  requestId: JsonRpcId
): JsonRpcResponse<McpToolCallResult> {
  // Convert result to content blocks
  const content: McpTextContent[] = [
    {
      type: 'text',
      text: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
    },
  ]

  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      content,
      isError: false,
    },
  }
}

/**
 * Encode an error event as an MCP tools/call error response.
 */
export function encodeToolCallError(
  event: ErrorEvent,
  requestId: JsonRpcId
): JsonRpcResponse<McpToolCallResult> {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      content: [
        {
          type: 'text',
          text: `Error: ${event.name}: ${event.message}`,
        },
      ],
      isError: true,
    },
  }
}

/**
 * Encode a cancelled event as an MCP tools/call error response.
 */
export function encodeToolCallCancelled(
  event: CancelledEvent,
  requestId: JsonRpcId
): JsonRpcResponse<McpToolCallResult> {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      content: [
        {
          type: 'text',
          text: event.reason ? `Cancelled: ${event.reason}` : 'Cancelled',
        },
      ],
      isError: true,
    },
  }
}

// =============================================================================
// UNIFIED ENCODER
// =============================================================================

/**
 * Encoder context for generating request IDs and tracking state.
 */
export interface EncoderContext {
  /** Generate a unique request ID */
  nextRequestId(): JsonRpcId
  /** Progress token for the current tool call */
  progressToken: string | number
  /** Logger name for log messages */
  logger?: string
  /** Original request ID for the tools/call request */
  toolCallRequestId: JsonRpcId
}

/**
 * Result of encoding a session event.
 */
export type EncodedMessage =
  | { type: 'notification'; message: JsonRpcNotification }
  | { type: 'request'; message: JsonRpcRequest; elicitId?: string; sampleId?: string }
  | { type: 'response'; message: JsonRpcResponse }

/**
 * Encode a ToolSessionEvent into an MCP message.
 *
 * @param event - The session event to encode
 * @param ctx - Encoder context
 * @returns The encoded MCP message with its type
 */
export function encodeSessionEvent<TResult = unknown>(
  event: ToolSessionEvent<TResult>,
  ctx: EncoderContext
): EncodedMessage {
  switch (event.type) {
    case 'progress':
      return {
        type: 'notification',
        message: encodeProgressNotification(event, ctx.progressToken),
      }

    case 'log':
      return {
        type: 'notification',
        message: encodeLogNotification(event, ctx.logger),
      }

    case 'elicit_request':
      return {
        type: 'request',
        message: encodeElicitationRequest(event, ctx.nextRequestId()),
        elicitId: event.elicitId,
      }

    case 'sample_request':
      return {
        type: 'request',
        message: encodeSamplingRequest(event, ctx.nextRequestId()),
        sampleId: event.sampleId,
      }

    case 'result':
      return {
        type: 'response',
        message: encodeToolCallResult(event, ctx.toolCallRequestId),
      }

    case 'error':
      return {
        type: 'response',
        message: encodeToolCallError(event, ctx.toolCallRequestId),
      }

    case 'cancelled':
      return {
        type: 'response',
        message: encodeToolCallCancelled(event, ctx.toolCallRequestId),
      }

    case 'sample_response_queued':
      // Internal event - should not be encoded for clients.
      // Return a notification with no content (will be filtered out).
      return {
        type: 'notification',
        message: {
          jsonrpc: '2.0' as const,
          method: 'internal/sample_response_queued',
          params: {},
        },
      }
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Create a simple encoder context.
 */
export function createEncoderContext(
  toolCallRequestId: JsonRpcId,
  progressToken?: string | number,
  logger?: string
): EncoderContext {
  let requestCounter = 0

  return {
    nextRequestId(): JsonRpcId {
      return `req_${++requestCounter}`
    },
    progressToken: progressToken ?? `progress_${toolCallRequestId}`,
    ...(logger !== undefined && { logger }),
    toolCallRequestId,
  }
}
