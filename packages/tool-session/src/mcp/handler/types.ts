/**
 * MCP HTTP Handler Types
 *
 * Type definitions for the MCP Streamable HTTP handler.
 *
 * ## MCP Streamable HTTP Transport
 *
 * The handler implements the MCP Streamable HTTP transport (spec 2025-11-25):
 * - Single endpoint supporting POST and GET
 * - POST for tools/call requests and elicit/sample responses
 * - GET for SSE streaming (server→client notifications and requests)
 * - MCP-Session-Id header for session management
 * - Last-Event-ID header for resumability
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http
 * @packageDocumentation
 */
import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { ToolInvocationNoticeReader, ToolSessionRegistry } from "../../contract.ts";
import type { ToolInvocationHost } from "../../invocation.ts";
import type { RuntimeTool } from "@sweatpants/agent-sdk";
import type { JsonRpcId } from "../protocol/types.ts";

// =============================================================================
// HANDLER CONFIGURATION
// =============================================================================

/**
 * Configuration for the MCP HTTP handler.
 */
export interface McpHandlerConfig {
  /**
   * Registry for locating the pull-only notice reader after the host starts
   * an invocation.
   */
  registry: ToolSessionRegistry;

  /** Pull-based control plane for starting and advancing tool invocations. */
  host: ToolInvocationHost;

  /**
   * Map of available tools by name.
   * Used to resolve tools/call requests.
   */
  tools: Map<string, RuntimeTool>;

  /**
   * Retention hint for the runtime. The handler does not own invocation lifetime.
   */
  sessionTimeout?: number;

  /**
   * SSE retry interval in milliseconds.
   * Sent in SSE events for client reconnection.
   * Default: 1000 (1 second)
   */
  sseRetryMs?: number;

  /**
   * Logger name for log messages.
   * Default: 'mcp-handler'
   */
  logger?: string;

  /**
   * Whether to include development info in error responses.
   * Default: false
   */
  includeStackTraces?: boolean;
}

// =============================================================================
// REQUEST TYPES
// =============================================================================

/**
 * MCP HTTP request method.
 */
export type McpHttpMethod = "GET" | "POST" | "DELETE";

/**
 * Parsed MCP request headers.
 */
export interface McpRequestHeaders {
  /** MCP-Session-Id header */
  sessionId?: string | undefined;
  /** Last-Event-ID header for resumability */
  lastEventId?: string | undefined;
  /** Negotiated MCP protocol version for post-initialize requests */
  protocolVersion?: string | undefined;
  /** Accept header */
  accept?: string | undefined;
  /** Content-Type header */
  contentType?: string | undefined;
}

/**
 * Parsed incoming MCP request.
 */
export interface McpParsedRequest {
  /** HTTP method */
  method: McpHttpMethod;
  /** Parsed headers */
  headers: McpRequestHeaders;
  /** Request body (for POST) */
  body?: unknown;
  /** Original request (for advanced use) */
  originalRequest: Request;
}

// =============================================================================
// REQUEST CLASSIFICATION
// =============================================================================

/**
 * Classification of an incoming MCP request.
 */
export type McpRequestType =
  | "tools_call" // POST tools/call - start new tool execution
  | "elicit_response" // POST elicitation response
  | "sample_response" // POST sampling response
  | "initialize" // POST initialize (optional, for capability negotiation)
  | "sse_stream" // GET - establish SSE stream
  | "terminate" // DELETE - end session
  | "unknown"; // Unrecognized request

/**
 * A tools/call request.
 */
export interface McpToolsCallRequest {
  type: "tools_call";
  requestId: JsonRpcId;
  toolName: string;
  /** Model-authored arguments; the authored tool schema is the only judge of shape. */
  arguments: Json;
  sessionId?: string | undefined;
}

/**
 * An elicitation response.
 */
export interface McpElicitResponse {
  type: "elicit_response";
  requestId: JsonRpcId;
  elicitId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown> | undefined;
  sessionId: string;
}

/**
 * A sampling response.
 */
export interface McpSampleResponse {
  type: "sample_response";
  requestId: JsonRpcId;
  sampleId: string;
  role: "assistant";
  content: unknown;
  model: string;
  stopReason?: string | undefined;
  sessionId: string;
}

/**
 * An SSE stream request.
 */
export interface McpSseStreamRequest {
  type: "sse_stream";
  sessionId: string;
  afterLSN?: number | undefined;
}

/**
 * A session terminate request.
 */
export interface McpTerminateRequest {
  type: "terminate";
  sessionId: string;
}

/**
 * An initialize request.
 */
export interface McpInitializeRequest {
  type: "initialize";
  requestId: JsonRpcId;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  clientInfo: { name: string; version: string };
}

/**
 * A tools/list request.
 */
export interface McpToolsListRequest {
  type: "tools_list";
  requestId: JsonRpcId;
}

/**
 * A ping request.
 */
export interface McpPingRequest {
  type: "ping";
  requestId: JsonRpcId;
}

/**
 * A notification (no response expected).
 */
export interface McpNotification {
  type: "notification";
  method: string;
  params?: unknown;
}

/**
 * Union of all classified requests.
 */
export type McpClassifiedRequest =
  | McpToolsCallRequest
  | McpElicitResponse
  | McpSampleResponse
  | McpSseStreamRequest
  | McpTerminateRequest
  | McpInitializeRequest
  | McpToolsListRequest
  | McpPingRequest
  | McpNotification;

// =============================================================================
// RESPONSE TYPES
// =============================================================================

/**
 * Result of handling a POST request.
 * Can be immediate (JSON) or deferred (SSE stream).
 */
export type McpPostResult =
  | { type: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { type: "sse"; sessionId: string; notices: ToolInvocationNoticeReader };

// =============================================================================
// SESSION STATE
// =============================================================================

/**
 * Pending elicitation request waiting for response.
 */
export interface PendingElicitation {
  elicitId: string;
  requestId: JsonRpcId;
  key: string;
  afterLSN: number;
}

/**
 * Pending sampling request waiting for response.
 */
export interface PendingSample {
  sampleId: string;
  requestId: JsonRpcId;
  afterLSN: number;
}

/**
 * Session state tracked by the handler.
 */
export interface McpSessionState {
  /** Session ID */
  sessionId: string;
  /** Pull-only UX and protocol notices. */
  notices: ToolInvocationNoticeReader;
  /** Original tools/call request ID */
  toolCallRequestId: JsonRpcId;
  /** Pending elicitation requests */
  pendingElicits: Map<string, PendingElicitation>;
  /** Pending sampling requests */
  pendingSamples: Map<string, PendingSample>;
  /** Last event LSN */
  lastLSN: number;
  /** Request ID counter for outgoing requests */
  requestCounter: number;
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * MCP handler error codes.
 */
export const MCP_HANDLER_ERRORS = {
  /** No session ID provided when required */
  SESSION_REQUIRED: "SESSION_REQUIRED",
  /** Session not found */
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  /** Tool not found */
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  /** Invalid request format */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** Method not allowed */
  METHOD_NOT_ALLOWED: "METHOD_NOT_ALLOWED",
  /** Accept header not valid for endpoint */
  NOT_ACCEPTABLE: "NOT_ACCEPTABLE",
  /** Elicitation/sample ID not found */
  REQUEST_NOT_FOUND: "REQUEST_NOT_FOUND",
} as const;

export type McpHandlerErrorCode = (typeof MCP_HANDLER_ERRORS)[keyof typeof MCP_HANDLER_ERRORS];

/**
 * Error thrown by the MCP handler.
 */
export class McpHandlerError extends Error {
  constructor(
    public readonly code: McpHandlerErrorCode,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly requestId: JsonRpcId | null = null,
  ) {
    super(message);
    this.name = "McpHandlerError";
  }
}

// =============================================================================
// HANDLER INTERFACE
// =============================================================================

/**
 * The MCP HTTP handler function signature.
 * Compatible with standard fetch API and framework adapters.
 */
export type McpHttpHandler = (request: Request) => Promise<Response>;

/**
 * Factory result for creating an MCP handler.
 */
export interface McpHandlerFactory {
  /**
   * The HTTP handler function.
   */
  handler: McpHttpHandler;

  /**
   * Get or create session state for a session ID.
   */
  getSessionState(sessionId: string): Operation<McpSessionState | null>;

  /**
   * Cleanup resources.
   */
  cleanup(): Operation<void>;
}
