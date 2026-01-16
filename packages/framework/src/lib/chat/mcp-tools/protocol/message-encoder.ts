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
 * 
 * Note: MCP 2025-11-25 supports URL mode elicitation for sensitive data flows
 * (OAuth, payments, etc.), but sweatpants does not support this yet.
 * If URL mode is requested, we throw a clear error.
 */
export function encodeElicitationRequest(
  event: ElicitRequestEvent,
  requestId: JsonRpcId
): JsonRpcRequest<'elicitation/create', McpElicitationParams> {
  // Guard against URL mode elicitation (not supported)
  if ((event as { mode?: string }).mode === 'url') {
    throw new Error(
      'URL elicitation mode is not supported by sweatpants. ' +
      'Use form mode (default) instead. ' +
      'See: https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation'
    )
  }

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
 * Reserved tool name for structured output.
 * Clients can intercept this and use native provider implementations.
 */
export const SCHEMA_TOOL_NAME = '__schema__'

/**
 * Encode a sample request event as an MCP sampling/createMessage request.
 * 
 * When a schema is provided, we use the __schema__ meta-tool pattern:
 * - Convert schema to a tool with name '__schema__'
 * - Set toolChoice to 'required'
 * - Client responds with tool_use containing data in input
 * 
 * Note: For internal exchanges, we mirror structured data into tool_result
 * with an empty tool_use input to model the flow in history. This encoder
 * still sends __schema__ as a tool to clients.
 *
 * This allows smart clients to use native structured output features
 * while naive clients can fall through to tool calling.
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
  let mcpTools: McpToolDefinition[] | undefined = event.tools?.map(tool => ({
    name: tool.name,
    ...(tool.description !== undefined && { description: tool.description }),
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }))

  // Build MCP tool choice
  let mcpToolChoice: McpToolChoice | undefined = event.toolChoice
    ? { mode: event.toolChoice }
    : undefined

  // __schema__ meta-tool pattern: convert schema to a reserved tool
  // This allows clients to use native structured output or fall through to tool calling
  if (event.schema !== undefined) {
    const schemaTool: McpToolDefinition = {
      name: SCHEMA_TOOL_NAME,
      description: 'Respond with structured data matching this schema.',
      inputSchema: event.schema as Record<string, unknown>,
    }
    
    // Prepend __schema__ tool (or create tools array)
    mcpTools = mcpTools ? [schemaTool, ...mcpTools] : [schemaTool]
    
    // Force tool use if schema is provided
    mcpToolChoice = { mode: 'required' }
  }

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
