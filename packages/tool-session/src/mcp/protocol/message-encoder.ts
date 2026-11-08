import type { Json } from "@sweatpants/foundation";
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
import type { ToolInvocationElicitAsk, ToolInvocationSampleAsk } from "../../invocation.ts";
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
  McpToolDefinition,
  McpToolChoice,
} from "./types.ts";
import type {
  ProgressEvent,
  LogEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,
} from "../../contract.ts";
import { SCHEMA_TOOL_NAME, type LogLevel as ToolLogLevel } from "@sweatpants/agent-sdk";
import { encodeElicitContext } from "../../elicit-context/index.ts";
import { chatMessagesToMcpMessages } from "../../messages.ts";

// =============================================================================
// LOG LEVEL MAPPING
// =============================================================================

/**
 * Map internal log levels to MCP log levels.
 * Our internal LogLevel is simpler than MCP's full range.
 */
function mapLogLevel(level: ToolLogLevel): McpLogLevel {
  switch (level) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "info";
  }
}

// =============================================================================
// NOTIFICATION ENCODERS
// =============================================================================

/**
 * Encode a progress event as an MCP progress notification.
 */
export function encodeProgressNotification(
  event: Pick<ProgressEvent, "message" | "progress">,
  progressToken: string | number,
): JsonRpcNotification<"notifications/progress", McpProgressParams> {
  return {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: {
      progressToken,
      progress: event.progress ?? 0,
      total: 1,
      message: event.message,
    },
  };
}

/**
 * Encode a log event as an MCP message notification.
 */
export function encodeLogNotification(
  event: Pick<LogEvent, "level" | "message">,
  logger?: string,
): JsonRpcNotification<"notifications/message", McpMessageParams> {
  return {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: {
      level: mapLogLevel(event.level),
      logger,
      data: event.message,
    },
  };
}

// =============================================================================
// REQUEST ENCODERS
// =============================================================================

/**
 * Encode an elicit request event as an MCP elicitation/create request.
 *
 * Note: MCP 2026-07-28 supports URL mode elicitation for sensitive data flows
 * (OAuth, payments, etc.), but sweatpants does not support this yet.
 * If URL mode is requested, we throw a clear error.
 */
export function encodeElicitationRequest(
  event: Omit<ToolInvocationElicitAsk, "kind" | "requestId" | "binding">,
  requestId: JsonRpcId,
): JsonRpcRequest<"elicitation/create", McpElicitationParams> {
  // Guard against URL mode elicitation (not supported)
  if ((event as { mode?: string }).mode === "url") {
    throw new Error(
      "URL elicitation mode is not supported by sweatpants. " +
        "Use form mode (default) instead. " +
        "See: https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation",
    );
  }

  const encoded =
    event.context === undefined
      ? { message: event.message, schema: event.schema }
      : encodeElicitContext(event.message, event.context, event.schema);
  return {
    jsonrpc: "2.0",
    id: requestId,
    method: "elicitation/create",
    params: {
      mode: "form",
      message: encoded.message,
      requestedSchema: encoded.schema,
    },
  };
}

/**
 * Reserved tool name for structured output.
 * Clients can intercept this and use native provider implementations.
 */
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
  event: Omit<ToolInvocationSampleAsk, "kind" | "requestId">,
  requestId: JsonRpcId,
): JsonRpcRequest<"sampling/createMessage", McpCreateMessageParams> {
  // Canonical Chat values are encoded once at this MCP boundary. System and
  // developer messages reject rather than being silently dropped.
  const mcpMessages = chatMessagesToMcpMessages(event.messages);

  // Build MCP tools from our tool definitions
  let mcpTools: McpToolDefinition[] | undefined = event.tools?.map((tool) => ({
    name: tool.name,
    /* CONDITIONAL-SPREAD: Omit absent description from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
    ...(tool.description !== null && { description: tool.description }),
    inputSchema: tool.parameters,
  }));

  // Build MCP tool choice
  let mcpToolChoice: McpToolChoice | undefined = event.toolChoice
    ? { mode: event.toolChoice }
    : undefined;

  // __schema__ meta-tool pattern: convert schema to a reserved tool
  // This allows clients to use native structured output or fall through to tool calling
  if (event.schema !== undefined) {
    const schemaTool: McpToolDefinition = {
      name: SCHEMA_TOOL_NAME,
      description: "Respond with structured data matching this schema.",
      inputSchema: event.schema as Record<string, unknown>,
    };

    // Prepend __schema__ tool (or create tools array)
    mcpTools = mcpTools ? [schemaTool, ...mcpTools] : [schemaTool];

    // Force tool use if schema is provided
    mcpToolChoice = { mode: "required" };
  }

  return {
    jsonrpc: "2.0",
    id: requestId,
    method: "sampling/createMessage",
    params: {
      messages: mcpMessages,
      /* CONDITIONAL-SPREAD: Omit absent systemPrompt from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(event.systemPrompt !== undefined && { systemPrompt: event.systemPrompt }),
      maxTokens: event.maxTokens ?? 4096,
      /* CONDITIONAL-SPREAD: Omit absent modelPreferences from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(event.modelPreferences === undefined ? {} : { modelPreferences: event.modelPreferences }),
      /* CONDITIONAL-SPREAD: Omit absent tools from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(mcpTools !== undefined && mcpTools.length > 0 && { tools: mcpTools }),
      /* CONDITIONAL-SPREAD: Omit absent toolChoice from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(mcpToolChoice !== undefined && { toolChoice: mcpToolChoice }),
    },
  };
}

// =============================================================================
// RESPONSE ENCODERS
// =============================================================================

/**
 * Encode a result event as an MCP tools/call response.
 */
export function encodeToolCallResult<TResult extends Json>(
  event: ResultEvent<TResult>,
  requestId: JsonRpcId,
): JsonRpcResponse<McpToolCallResult> {
  // Convert result to content blocks
  const content: McpTextContent[] = [
    {
      type: "text",
      text: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
    },
  ];

  return {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      resultType: "complete",
      content,
      isError: false,
    },
  };
}

/**
 * Encode an error event as an MCP tools/call error response.
 */
export function encodeToolCallError(
  event: ErrorEvent,
  requestId: JsonRpcId,
): JsonRpcResponse<McpToolCallResult> {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      resultType: "complete",
      content: [
        {
          type: "text",
          text: `Error: ${event.name}: ${event.message}`,
        },
      ],
      isError: true,
    },
  };
}

/**
 * Encode a cancelled event as an MCP tools/call error response.
 */
export function encodeToolCallCancelled(
  event: CancelledEvent,
  requestId: JsonRpcId,
): JsonRpcResponse<McpToolCallResult> {
  return {
    jsonrpc: "2.0",
    id: requestId,
    result: {
      resultType: "complete",
      content: [
        {
          type: "text",
          text: event.reason ? `Cancelled: ${event.reason}` : "Cancelled",
        },
      ],
      isError: true,
    },
  };
}
