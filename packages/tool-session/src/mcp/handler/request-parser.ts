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
import { call, type Operation } from "effection";
import { parser } from "@sweatpants/foundation";
import { z } from "zod";
import { MCP_PROTOCOL_VERSION } from "../protocol-version.ts";
import {
  MCP_HANDLER_ERRORS,
  McpHandlerError,
  type McpParsedRequest,
  type McpRequestHeaders,
  type McpHttpMethod,
  type McpClassifiedRequest,
  type McpToolsCallRequest,
  type McpElicitResponse,
  type McpSampleResponse,
  type McpSseStreamRequest,
  type McpTerminateRequest,
  type McpInitializeRequest,
  type McpToolsListRequest,
  type McpPingRequest,
  type McpNotification,
} from "./types.ts";
import { parseEventId } from "../protocol/sse-formatter.ts";
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "../protocol/types.ts";

export const MCP_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const requestEncoder = new TextEncoder();
const requestIdSchema = z.union([z.string().max(512), z.number()]);
const jsonRpcRequestSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  method: z.string().min(1),
  params: z.json().optional(),
});
const jsonRpcNotificationSchema = z
  .looseObject({
    jsonrpc: z.literal("2.0"),
    method: z.string().min(1),
    params: z.json().optional(),
  })
  .refine((value) => !("id" in value));
const jsonRpcResponseSchema = z
  .looseObject({
    jsonrpc: z.literal("2.0"),
    id: z.union([requestIdSchema, z.null()]),
    result: z.json().optional(),
    error: z
      .object({ code: z.number(), message: z.string(), data: z.json().optional() })
      .strict()
      .optional(),
  })
  .refine((value) => value.result !== undefined || value.error !== undefined);
const elicitationResultSchema = z.object({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.json()).optional(),
});
const samplingResultSchema = z.object({
  role: z.literal("assistant"),
  content: z.json(),
  model: z.string(),
  stopReason: z.string().optional(),
});
const jsonRpcEnvelopeParser = parser(
  z.union([jsonRpcNotificationSchema, jsonRpcRequestSchema, jsonRpcResponseSchema]),
);
const responseResultParser = parser(z.union([elicitationResultSchema, samplingResultSchema]));
const initializeParamsParser = parser(
  z.looseObject({
    protocolVersion: z.string().min(1),
    capabilities: z.record(z.string(), z.json()).optional(),
    clientInfo: z.looseObject({ name: z.string(), version: z.string() }).optional(),
  }),
);
const toolCallParamsParser = parser(
  z.looseObject({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.json()).optional(),
  }),
);

// =============================================================================
// HEADER PARSING
// =============================================================================

/**
 * Parse MCP-relevant headers from a request.
 */
export function parseHeaders(request: Request): McpRequestHeaders {
  const sessionId = request.headers.get("Mcp-Session-Id");
  const lastEventId = request.headers.get("Last-Event-ID");
  const protocolVersion = request.headers.get("MCP-Protocol-Version");
  const accept = request.headers.get("Accept");
  const contentType = request.headers.get("Content-Type");

  return {
    ...(sessionId != null && { sessionId }),
    ...(lastEventId != null && { lastEventId }),
    ...(protocolVersion != null && { protocolVersion }),
    ...(accept != null && { accept }),
    ...(contentType != null && { contentType }),
  };
}

/**
 * Validate headers for a POST request.
 */
export function assertPostHeaders(headers: McpRequestHeaders): void {
  if (headers.contentType && !headers.contentType.includes("application/json")) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      "POST requests must have Content-Type: application/json",
      415, // Unsupported Media Type
    );
  }
}

/**
 * Validate headers for a GET request.
 */
export function assertGetHeaders(headers: McpRequestHeaders): void {
  if (!headers.accept?.includes("text/event-stream")) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.NOT_ACCEPTABLE,
      "GET requests must Accept: text/event-stream",
      406, // Not Acceptable
    );
  }
}

// =============================================================================
// REQUEST PARSING
// =============================================================================

/**
 * Parse an incoming HTTP request.
 */
export function* parseRequest(request: Request): Operation<McpParsedRequest> {
  const method = request.method.toUpperCase() as McpHttpMethod;

  // Validate method
  if (!["GET", "POST", "DELETE"].includes(method)) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.METHOD_NOT_ALLOWED,
      `Method ${method} not allowed`,
      405,
    );
  }

  const headers = parseHeaders(request);

  // Parse body for POST
  let body: unknown;
  if (method === "POST") {
    assertPostHeaders(headers);
    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BYTES) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.INVALID_REQUEST,
        "MCP request body exceeds 2 MiB",
        413,
      );
    }
    try {
      const text = yield* call(() => request.text());
      if (requestEncoder.encode(text).byteLength > MCP_MAX_REQUEST_BYTES) {
        throw new McpHandlerError(
          MCP_HANDLER_ERRORS.INVALID_REQUEST,
          "MCP request body exceeds 2 MiB",
          413,
        );
      }
      body = JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof McpHandlerError) {
        throw error;
      }
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.INVALID_REQUEST,
        "Invalid JSON in request body",
        400,
      );
    }
  }

  // Validate GET headers
  if (method === "GET") {
    assertGetHeaders(headers);
  }

  return {
    method,
    headers,
    body,
    originalRequest: request,
  };
}

// =============================================================================
// REQUEST CLASSIFICATION
// =============================================================================

/**
 * Classify a POST request body as tools/call, elicit response, or sample response.
 */
function classifyPostBody(
  body: unknown,
  sessionId: string | undefined,
):
  | McpToolsCallRequest
  | McpElicitResponse
  | McpSampleResponse
  | McpInitializeRequest
  | McpToolsListRequest
  | McpPingRequest
  | McpNotification {
  const parsedEnvelope = jsonRpcEnvelopeParser.parse(body);
  if (!parsedEnvelope.ok) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      "Request body must be a JSON-RPC request or response",
      400,
    );
  }
  const envelope = parsedEnvelope.value;

  // Check for JSON-RPC notification (no id - fire and forget)
  if ("method" in envelope && !("id" in envelope)) {
    const notif = envelope as { method: string; params?: unknown };
    return {
      type: "notification",
      method: notif.method,
      params: notif.params,
    };
  }

  // Check for JSON-RPC request (tools/call, initialize, tools/list)
  if ("method" in envelope) {
    const req = envelope as JsonRpcRequest;

    if (req.method === "ping") {
      return {
        type: "ping",
        requestId: req.id,
      };
    }

    if (req.method === "initialize") {
      const params = initializeParamsParser.parse(req.params);
      if (!params.ok) {
        throw new McpHandlerError(
          MCP_HANDLER_ERRORS.INVALID_REQUEST,
          "initialize requires params.protocolVersion",
          400,
          req.id,
        );
      }
      return {
        type: "initialize",
        requestId: req.id,
        protocolVersion: params.value.protocolVersion,
        capabilities: params.value.capabilities ?? {},
        clientInfo: params.value.clientInfo ?? { name: "unknown", version: "0.0.0" },
      };
    }

    if (req.method === "tools/list") {
      return {
        type: "tools_list",
        requestId: req.id,
      };
    }

    if (req.method === "tools/call") {
      const params = toolCallParamsParser.parse(req.params);
      if (!params.ok) {
        throw new McpHandlerError(
          MCP_HANDLER_ERRORS.INVALID_REQUEST,
          "tools/call requires params.name",
          400,
        );
      }

      const result: McpToolsCallRequest = {
        type: "tools_call",
        requestId: req.id,
        toolName: params.value.name,
        arguments: params.value.arguments ?? {},
      };
      if (sessionId !== undefined) {
        result.sessionId = sessionId;
      }
      return result;
    }

    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      `Unsupported request method: ${req.method}`,
      400,
    );
  }

  // Check for JSON-RPC response (elicit or sample response)
  {
    const resp = envelope as JsonRpcResponse;

    // Must have a session for responses
    if (!sessionId) {
      throw new McpHandlerError(
        MCP_HANDLER_ERRORS.SESSION_REQUIRED,
        "Session ID required for responses",
        400,
      );
    }

    // Check for error response - convert to elicit cancel/decline
    // MCP clients may send error responses when user rejects elicitation/sampling
    // Error code -1 = USER_REJECTED per MCP spec
    if ("error" in resp) {
      const errorResp = resp as { id: JsonRpcId | null; error: { code: number; message: string } };

      // Error responses may have null id - we can't correlate them without an id
      if (errorResp.id === null) {
        throw new McpHandlerError(
          MCP_HANDLER_ERRORS.INVALID_REQUEST,
          "Error response with null id cannot be correlated",
          400,
        );
      }

      // Treat as elicitation decline/cancel
      // The request ID tells us which elicitation/sampling this responds to
      return {
        type: "elicit_response",
        requestId: errorResp.id,
        elicitId: String(errorResp.id),
        action: errorResp.error.code === -1 ? "decline" : "cancel",
        sessionId,
      };
    }

    const result = (resp as { result: unknown }).result;

    const parsedResult = responseResultParser.parse(result);
    if (parsedResult.ok && "action" in parsedResult.value) {
      const elicitResult: McpElicitResponse = {
        type: "elicit_response",
        requestId: resp.id,
        elicitId: String(resp.id),
        action: parsedResult.value.action,
        sessionId,
      };
      if (parsedResult.value.content !== undefined) {
        elicitResult.content = parsedResult.value.content;
      }
      return elicitResult;
    }

    if (parsedResult.ok && "role" in parsedResult.value) {
      const sampleResult: McpSampleResponse = {
        type: "sample_response",
        requestId: resp.id,
        sampleId: String(resp.id),
        role: parsedResult.value.role,
        content: parsedResult.value.content,
        model: parsedResult.value.model,
        sessionId,
      };
      if (parsedResult.value.stopReason !== undefined) {
        sampleResult.stopReason = parsedResult.value.stopReason;
      }
      return sampleResult;
    }

    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.INVALID_REQUEST,
      "Unrecognized response format",
      400,
    );
  }
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
      type: "sse_stream",
      sessionId: "", // Empty = idle stream
    };
  }

  // Parse Last-Event-ID for resumability
  let afterLSN: number | undefined;
  if (headers.lastEventId) {
    const parsed = parseEventId(headers.lastEventId);
    if (parsed && parsed.sessionId === headers.sessionId) {
      afterLSN = parsed.lsn;
    }
  }

  const result: McpSseStreamRequest = {
    type: "sse_stream",
    sessionId: headers.sessionId,
  };
  if (afterLSN !== undefined) {
    result.afterLSN = afterLSN;
  }
  return result;
}

/**
 * Classify a DELETE request for session termination.
 */
function classifyDeleteRequest(headers: McpRequestHeaders): McpTerminateRequest {
  if (!headers.sessionId) {
    throw new McpHandlerError(
      MCP_HANDLER_ERRORS.SESSION_REQUIRED,
      "Mcp-Session-Id header required for session termination",
      400,
    );
  }

  return {
    type: "terminate",
    sessionId: headers.sessionId,
  };
}

// =============================================================================
// MAIN CLASSIFIER
// =============================================================================

/**
 * Classify a parsed MCP request.
 */
export function classifyRequest(parsed: McpParsedRequest): McpClassifiedRequest {
  switch (parsed.method) {
    case "POST": {
      const classified = classifyPostBody(parsed.body, parsed.headers.sessionId);
      if (
        classified.type !== "initialize" &&
        parsed.headers.protocolVersion !== undefined &&
        parsed.headers.protocolVersion !== MCP_PROTOCOL_VERSION
      ) {
        const requestId = "requestId" in classified ? classified.requestId : null;
        throw new McpHandlerError(
          MCP_HANDLER_ERRORS.INVALID_REQUEST,
          `MCP-Protocol-Version must be ${MCP_PROTOCOL_VERSION}`,
          400,
          requestId,
        );
      }
      return classified;
    }

    case "GET":
      return classifyGetRequest(parsed.headers);

    case "DELETE":
      return classifyDeleteRequest(parsed.headers);
  }
}

/**
 * Parse and classify an incoming request in one step.
 */
export function* parseAndClassify(request: Request): Operation<McpClassifiedRequest> {
  const parsed = yield* parseRequest(request);
  return classifyRequest(parsed);
}
