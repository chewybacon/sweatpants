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
 * | elicitation/create      | host.turn({ resume: "elicit" })   |
 * | sampling/createMessage  | host.turn({ resume: "sample" })   |
 *
 * @packageDocumentation
 */
import { z } from "zod";
import { parser, type Json } from "@sweatpants/foundation";
import type { ChatToolCall } from "@sweatpants/chat-contract";
import {
  isJsonRpcError,
  isJsonRpcSuccess,
  isTextContent,
  isToolUseContent,
  type JsonRpcResponse,
  type JsonRpcRequest,
  type JsonRpcNotification,
  type McpElicitationResult,
  type McpCreateMessageResult,
  type McpToolCallParams,
  type McpContentBlock,
} from "./types.ts";
import type {
  ElicitExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "@sweatpants/agent-sdk";

// =============================================================================
// DECODED TYPES
// =============================================================================

/**
 * Unified sample result type for decoded messages.
 * Uses raw result types (without exchange) since the decoder doesn't have
 * access to the original prompt text needed to construct exchanges.
 * The exchange is added by the runtime layer (for example bridge-runtime).
 */
export type DecodedSampleResult =
  | SampleExchangeCompletionBase
  | ParsedSampleExchangeCompletion<unknown>
  | ToolCallSampleExchangeCompletion;

/**
 * Result of decoding an MCP message.
 */
export type DecodedMessage =
  | { type: "elicitation_response"; elicitId: string; result: ElicitExchangeCompletion<unknown> }
  | { type: "sampling_response"; sampleId: string; result: DecodedSampleResult }
  | { type: "tool_call"; name: string; args: Json; requestId: string | number }
  | { type: "error"; code: number; message: string; data?: unknown }
  | { type: "unknown"; raw: unknown };

// =============================================================================
// ELICITATION DECODER
// =============================================================================

/**
 * Decode an MCP elicitation response into a ElicitExchangeCompletion.
 *
 * The wire result carries no exchange: exchange construction happens only in
 * the layer that holds the originating call's context (bridge / worker).
 */
export function decodeElicitationResponse(
  response: JsonRpcResponse<McpElicitationResult>,
  elicitId: string,
): DecodedMessage {
  if (isJsonRpcError(response)) {
    return {
      type: "error",
      code: response.error.code,
      message: response.error.message,
      data: response.error.data,
    };
  }

  if (!isJsonRpcSuccess(response)) {
    return { type: "unknown", raw: response };
  }

  const mcpResult = response.result;

  let elicitResult: ElicitExchangeCompletion<unknown>;

  switch (mcpResult.action) {
    case "accept":
      elicitResult = { action: "accept", content: mcpResult.content ?? {} };
      break;
    case "decline":
      elicitResult = { action: "decline" };
      break;
    case "cancel":
      elicitResult = { action: "cancel" };
      break;
    default:
      return { type: "unknown", raw: response };
  }

  return {
    type: "elicitation_response",
    elicitId,
    result: elicitResult,
  };
}

// =============================================================================
// SAMPLING DECODER
// =============================================================================

/**
 * Extract text from MCP content blocks.
 */
function extractTextFromContent(content: McpContentBlock | McpContentBlock[]): string {
  const blocks = Array.isArray(content) ? content : [content];
  const textBlocks = blocks.filter(isTextContent);
  return textBlocks.map((b) => b.text).join("\n");
}

/**
 * Extract tool calls from MCP content blocks.
 */
function extractToolCallsFromContent(content: McpContentBlock | McpContentBlock[]): ChatToolCall[] {
  const blocks = Array.isArray(content) ? content : [content];
  const toolUseBlocks = blocks.filter(isToolUseContent);
  return toolUseBlocks.map((block) => ({
    id: block.id,
    name: block.name,
    input: block.input,
    thoughtSignature: null,
  }));
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
  sampleId: string,
): DecodedMessage {
  if (isJsonRpcError(response)) {
    return {
      type: "error",
      code: response.error.code,
      message: response.error.message,
      data: response.error.data,
    };
  }

  if (!isJsonRpcSuccess(response)) {
    return { type: "unknown", raw: response };
  }

  const mcpResult = response.result;

  // Extract text from content
  const text = extractTextFromContent(mcpResult.content);

  // Check if this is a tool use response
  if (mcpResult.stopReason === "toolUse") {
    const toolCalls = extractToolCallsFromContent(mcpResult.content);
    const result: ToolCallSampleExchangeCompletion = {
      text,
      model: mcpResult.model,
      stopReason: "toolUse",
      toolCalls,
    };
    return {
      type: "sampling_response",
      sampleId,
      result,
    };
  }

  // Return base result (structured output parsing happens at runtime layer)
  const result: SampleExchangeCompletionBase = {
    text,
    model: mcpResult.model,
    /* CONDITIONAL-SPREAD: Omit absent stopReason from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
    ...(mcpResult.stopReason !== undefined && { stopReason: mcpResult.stopReason }),
  };

  return {
    type: "sampling_response",
    sampleId,
    result,
  };
}

// =============================================================================
// TOOL CALL DECODER
// =============================================================================

/**
 * Decode an MCP tools/call request. `parseToolCallRequest` is the owning parser
 * and already proves `params.name`, so this decoder demands the parsed shape
 * instead of inventing an empty name for a request that cannot exist.
 */
export function decodeToolCallRequest(
  request: JsonRpcRequest<"tools/call", McpToolCallParams> & { params: McpToolCallParams },
): DecodedMessage {
  return {
    type: "tool_call",
    name: request.params.name,
    args: request.params.arguments ?? {},
    requestId: request.id,
  };
}

// =============================================================================
// GENERIC DECODER
// =============================================================================

/**
 * Pending response tracking for correlating responses with their requests.
 */
export interface PendingRequest {
  type: "elicitation" | "sampling";
  id: string; // elicitId or sampleId
}

/**
 * Decoder context for tracking pending requests.
 */
export interface DecoderContext {
  /**
   * Map of JSON-RPC request ID to pending request info.
   */
  pendingRequests: Map<string | number, PendingRequest>;

  /**
   * Add a pending elicitation request.
   */
  addPendingElicitation(requestId: string | number, elicitId: string): void;

  /**
   * Add a pending sampling request.
   */
  addPendingSampling(requestId: string | number, sampleId: string): void;
}

/**
 * Create a decoder context for tracking pending requests.
 */
export function createDecoderContext(): DecoderContext {
  const pendingRequests = new Map<string | number, PendingRequest>();

  return {
    pendingRequests,
    addPendingElicitation(requestId, elicitId) {
      pendingRequests.set(requestId, { type: "elicitation", id: elicitId });
    },
    addPendingSampling(requestId, sampleId) {
      pendingRequests.set(requestId, { type: "sampling", id: sampleId });
    },
  };
}

/**
 * Decode a JSON-RPC response using context to correlate with the original request.
 */
export function decodeResponse(response: JsonRpcResponse, ctx: DecoderContext): DecodedMessage {
  const requestId = isJsonRpcSuccess(response) || isJsonRpcError(response) ? response.id : null;

  if (requestId === null) {
    return { type: "unknown", raw: response };
  }

  const pending = ctx.pendingRequests.get(requestId);
  if (!pending) {
    return { type: "unknown", raw: response };
  }

  // Remove from pending
  ctx.pendingRequests.delete(requestId);

  switch (pending.type) {
    case "elicitation":
      const elicitation = parseElicitationResponse(response);
      return elicitation
        ? decodeElicitationResponse(elicitation, pending.id)
        : { type: "unknown", raw: response };
    case "sampling": {
      const sampling = parseSamplingResponse(response);
      return sampling
        ? decodeSamplingResponse(sampling, pending.id)
        : { type: "unknown", raw: response };
    }
  }
}

// =============================================================================
// MESSAGE PARSING
// =============================================================================

/**
 * Parsed JSON-RPC message union type.
 */
export const MCP_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const messageEncoder = new TextEncoder();

export type ParsedJsonRpcMessage =
  | { type: "request"; message: JsonRpcRequest }
  | { type: "notification"; message: JsonRpcNotification }
  | { type: "response"; message: JsonRpcResponse }
  | { type: "invalid"; raw: unknown; error: string };

/**
 * Parse a raw JSON string into a typed JSON-RPC message.
 */
export function parseJsonRpcMessage(raw: string): ParsedJsonRpcMessage {
  if (messageEncoder.encode(raw).byteLength > MCP_MAX_MESSAGE_BYTES) {
    return { type: "invalid", raw: undefined, error: "Message exceeds 2 MiB" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return { type: "invalid", raw, error: "Invalid JSON" };
  }

  const parsed = jsonRpcMessageEnvelopeParser.parse(decoded);
  if (!parsed.ok) {
    return {
      type: "invalid",
      raw: decoded,
      error:
        typeof decoded === "object" && decoded !== null ? "Unknown message type" : "Not an object",
    };
  }
  const message = parsed.value;
  if ("result" in message || "error" in message) {
    return { type: "response", message: message as JsonRpcResponse };
  }
  if ("id" in message) {
    if (message.method === "tools/call") {
      const toolCall = parseToolCallRequest(message);
      return toolCall
        ? { type: "request", message: toolCall }
        : { type: "invalid", raw: decoded, error: "Invalid tools/call request" };
    }
    return { type: "request", message: message as JsonRpcRequest };
  }
  return { type: "notification", message: message as JsonRpcNotification };
}

const jsonRpcIdSchema = z.union([z.string().max(512), z.number(), z.null()]);
const jsonRpcRequestEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(512), z.number()]),
    method: z.string().min(1).max(4_096),
    params: z.json().optional(),
  })
  .strict();
const jsonRpcNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1).max(4_096),
    params: z.json().optional(),
  })
  .strict();
const jsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string().max(16_384),
    data: z.json().optional(),
  })
  .strict();
const jsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(512), z.number()]),
    result: z.json(),
  })
  .strict();
const jsonRpcErrorResponseSchema = z
  .object({ jsonrpc: z.literal("2.0"), id: jsonRpcIdSchema, error: jsonRpcErrorSchema })
  .strict();
const mcpContentBlockSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict(),
    z.object({ type: z.literal("audio"), data: z.string(), mimeType: z.string() }).strict(),
    z
      .object({
        type: z.literal("resource"),
        resource: z
          .object({
            uri: z.string(),
            text: z.string().optional(),
            blob: z.string().optional(),
            mimeType: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("tool_use"),
        id: z.string().min(1),
        name: z.string().min(1),
        input: z.record(z.string(), z.json()),
      })
      .strict(),
    z
      .object({
        type: z.literal("tool_result"),
        toolUseId: z.string().min(1),
        content: z.array(mcpContentBlockSchema).max(1_024),
        isError: z.boolean().optional(),
      })
      .strict(),
  ]),
);
const toolCallParamsSchema = z
  .object({
    name: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.json()).optional(),
  })
  .strict();
const elicitationResultSchema = z
  .object({
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.json()).optional(),
  })
  .strict();
const samplingResultSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.union([mcpContentBlockSchema, z.array(mcpContentBlockSchema).min(1).max(1_024)]),
    model: z.string().max(512),
    stopReason: z.string().max(128).optional(),
  })
  .strict();
const jsonRpcResponseParser = parser(z.union([jsonRpcErrorResponseSchema, jsonRpcSuccessSchema]));
const jsonRpcMessageEnvelopeParser = parser(
  z.union([
    jsonRpcErrorResponseSchema,
    jsonRpcSuccessSchema,
    jsonRpcRequestEnvelopeSchema,
    jsonRpcNotificationEnvelopeSchema,
  ]),
);
const toolCallParamsParser = parser(toolCallParamsSchema);
const elicitationResultParser = parser(elicitationResultSchema);
const samplingResultParser = parser(samplingResultSchema);

function parseJsonRpcResponse(value: unknown): JsonRpcResponse | undefined {
  const parsed = jsonRpcResponseParser.parse(value);
  return parsed.ok ? (parsed.value as JsonRpcResponse) : undefined;
}

function parseToolCallRequest(
  value: z.infer<typeof jsonRpcRequestEnvelopeSchema>,
): JsonRpcRequest<"tools/call", McpToolCallParams> | undefined {
  if (value.method !== "tools/call") {
    return undefined;
  }
  const params = toolCallParamsParser.parse(value.params);
  if (!params.ok) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    id: value.id,
    method: "tools/call",
    params: {
      name: params.value.name,
      /* CONDITIONAL-SPREAD: Omit absent arguments from tool-session and MCP payloads; explicit undefined is not a portable JSON value. */
      ...(params.value.arguments !== undefined ? { arguments: params.value.arguments } : {}),
    },
  };
}

function parseElicitationResponse(
  value: unknown,
): JsonRpcResponse<McpElicitationResult> | undefined {
  const response = parseJsonRpcResponse(value);
  if (!response) {
    return undefined;
  }
  if (isJsonRpcError(response)) {
    return response as JsonRpcResponse<McpElicitationResult>;
  }
  if (!isJsonRpcSuccess(response)) {
    return undefined;
  }
  const result = elicitationResultParser.parse(response.result);
  return result.ok
    ? ({ ...response, result: result.value } as JsonRpcResponse<McpElicitationResult>)
    : undefined;
}

function parseSamplingResponse(
  value: unknown,
): JsonRpcResponse<McpCreateMessageResult> | undefined {
  const response = parseJsonRpcResponse(value);
  if (!response) {
    return undefined;
  }
  if (isJsonRpcError(response)) {
    return response as JsonRpcResponse<McpCreateMessageResult>;
  }
  if (!isJsonRpcSuccess(response)) {
    return undefined;
  }
  const result = samplingResultParser.parse(response.result);
  return result.ok
    ? ({ ...response, result: result.value } as JsonRpcResponse<McpCreateMessageResult>)
    : undefined;
}
