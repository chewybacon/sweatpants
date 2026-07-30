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
import { z } from "zod";
import type {
  JsonRpcResponse,
  JsonRpcRequest,
  JsonRpcNotification,
  McpElicitationResult,
  McpCreateMessageResult,
  McpToolCallParams,
  McpContentBlock,
} from "./types.ts";
import { isJsonRpcError, isJsonRpcSuccess, isTextContent, isToolUseContent } from "./types.ts";
import type {
  WireElicitResult,
  WireSampleResultBase,
  WireSampleResultWithParsed,
  WireSampleResultWithToolCalls,
  SamplingToolCall,
} from "../mcp-tool-types.ts";

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
  | WireSampleResultBase
  | WireSampleResultWithParsed<unknown>
  | WireSampleResultWithToolCalls;

/**
 * Result of decoding an MCP message.
 */
export type DecodedMessage =
  | { type: "elicitation_response"; elicitId: string; result: WireElicitResult<unknown> }
  | { type: "sampling_response"; sampleId: string; result: DecodedSampleResult }
  | { type: "tool_call"; name: string; args: Record<string, unknown>; requestId: string | number }
  | { type: "error"; code: number; message: string; data?: unknown }
  | { type: "unknown"; raw: unknown };

// =============================================================================
// ELICITATION DECODER
// =============================================================================

/**
 * Decode an MCP elicitation response into a WireElicitResult.
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

  let elicitResult: WireElicitResult<unknown>;

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
function extractToolCallsFromContent(
  content: McpContentBlock | McpContentBlock[],
): SamplingToolCall[] {
  const blocks = Array.isArray(content) ? content : [content];
  const toolUseBlocks = blocks.filter(isToolUseContent);
  return toolUseBlocks.map((block) => ({
    id: block.id,
    name: block.name,
    arguments: block.input,
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
    const result: WireSampleResultWithToolCalls = {
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
  const result: WireSampleResultBase = {
    text,
    model: mcpResult.model,
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
 * Decode an MCP tools/call request.
 */
export function decodeToolCallRequest(
  request: JsonRpcRequest<"tools/call", McpToolCallParams>,
): DecodedMessage {
  return {
    type: "tool_call",
    name: request.params?.name ?? "",
    args: request.params?.arguments ?? {},
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
export type ParsedJsonRpcMessage =
  | { type: "request"; message: JsonRpcRequest }
  | { type: "notification"; message: JsonRpcNotification }
  | { type: "response"; message: JsonRpcResponse }
  | { type: "invalid"; raw: unknown; error: string };

/**
 * Parse a raw JSON string into a typed JSON-RPC message.
 */
export function parseJsonRpcMessage(raw: string): ParsedJsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "invalid", raw, error: "Invalid JSON" };
  }

  const response = parseJsonRpcResponse(parsed);
  if (response) {
    return { type: "response", message: response };
  }

  const request = jsonRpcRequestEnvelopeSchema.safeParse(parsed);
  if (request.success) {
    if (request.data.method === "tools/call") {
      const toolCall = parseToolCallRequest(request.data);
      return toolCall
        ? { type: "request", message: toolCall }
        : { type: "invalid", raw: parsed, error: "Invalid tools/call request" };
    }
    return { type: "request", message: request.data };
  }

  const notification = jsonRpcNotificationEnvelopeSchema.safeParse(parsed);
  if (notification.success) return { type: "notification", message: notification.data };
  return {
    type: "invalid",
    raw: parsed,
    error: typeof parsed === "object" && parsed !== null ? "Unknown message type" : "Not an object",
  };
}

const jsonRpcIdSchema = z.union([z.string().max(512), z.number().finite(), z.null()]);
const jsonRpcRequestEnvelopeSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(512), z.number().finite()]),
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
    code: z.number().int().finite(),
    message: z.string().max(16_384),
    data: z.json().optional(),
  })
  .strict();
const jsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string().max(512), z.number().finite()]),
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
        content: z.array(mcpContentBlockSchema),
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
    content: z.union([mcpContentBlockSchema, z.array(mcpContentBlockSchema).min(1)]),
    model: z.string().max(512),
    stopReason: z.string().max(128).optional(),
  })
  .strict();

function parseJsonRpcResponse(value: unknown): JsonRpcResponse | undefined {
  const error = jsonRpcErrorResponseSchema.safeParse(value);
  if (error.success) return error.data as JsonRpcResponse;
  const success = jsonRpcSuccessSchema.safeParse(value);
  return success.success ? (success.data as JsonRpcResponse) : undefined;
}

function parseToolCallRequest(
  value: z.infer<typeof jsonRpcRequestEnvelopeSchema>,
): JsonRpcRequest<"tools/call", McpToolCallParams> | undefined {
  if (value.method !== "tools/call") return undefined;
  const params = toolCallParamsSchema.safeParse(value.params);
  if (!params.success) return undefined;
  return {
    jsonrpc: "2.0",
    id: value.id,
    method: "tools/call",
    params: {
      name: params.data.name,
      ...(params.data.arguments !== undefined ? { arguments: params.data.arguments } : {}),
    },
  };
}

function parseElicitationResponse(
  value: unknown,
): JsonRpcResponse<McpElicitationResult> | undefined {
  const response = parseJsonRpcResponse(value);
  if (!response) return undefined;
  if (isJsonRpcError(response)) return response as JsonRpcResponse<McpElicitationResult>;
  if (!isJsonRpcSuccess(response)) return undefined;
  const result = elicitationResultSchema.safeParse(response.result);
  return result.success
    ? ({ ...response, result: result.data } as JsonRpcResponse<McpElicitationResult>)
    : undefined;
}

function parseSamplingResponse(
  value: unknown,
): JsonRpcResponse<McpCreateMessageResult> | undefined {
  const response = parseJsonRpcResponse(value);
  if (!response) return undefined;
  if (isJsonRpcError(response)) return response as JsonRpcResponse<McpCreateMessageResult>;
  if (!isJsonRpcSuccess(response)) return undefined;
  const result = samplingResultSchema.safeParse(response.result);
  return result.success
    ? ({ ...response, result: result.data } as JsonRpcResponse<McpCreateMessageResult>)
    : undefined;
}
