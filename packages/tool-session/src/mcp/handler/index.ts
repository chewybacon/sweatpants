/**
 * MCP HTTP Handler Module
 *
 * Implements the MCP Streamable HTTP transport (spec 2025-11-25).
 *
 * ## Quick Start
 *
 * ```typescript
 * Compose this transport with a ToolSessionRegistry supplied by a runtime
 * adapter; the framework does not import or construct that adapter.
 * const tools = new Map([['my_tool', myTool]])
 *
 * const { handler } = createMcpHandler({
 *   registry,
 *   tools,
 * })
 *
 * // Use with any HTTP framework
 * app.all('/mcp', handler)
 * ```
 *
 * @packageDocumentation
 */

// Main handler factory
export { createMcpHandler, type McpHandlerOptions } from "./mcp-handler.ts";

// Types
export type {
  // Config
  McpHandlerConfig,
  McpHttpHandler,
  // Request types
  McpHttpMethod,
  McpRequestHeaders,
  McpParsedRequest,
  McpRequestType,
  McpClassifiedRequest,
  McpToolsCallRequest,
  McpElicitResponse,
  McpSampleResponse,
  McpSseStreamRequest,
  McpTerminateRequest,
  McpInitializeRequest,
  McpToolsListRequest,
  McpPingRequest,
  McpNotification,
  // Response types
  McpPostResult,
  // Session state
  McpSessionState,
  PendingElicitation,
  PendingSample,
  // Error types
  McpHandlerErrorCode,
} from "./types.ts";

// Error class and codes
export { McpHandlerError, MCP_HANDLER_ERRORS } from "./types.ts";

// Request parsing (for custom handlers)
export {
  MCP_MAX_REQUEST_BYTES,
  parseHeaders,
  assertPostHeaders,
  assertGetHeaders,
  parseRequest,
  classifyRequest,
  parseAndClassify,
} from "./request-parser.ts";

// Session manager (for advanced use)
export {
  McpSessionManager,
  McpSessionManagerContext,
  createSessionManager,
  type McpSessionManagerOptions,
} from "./session-manager.ts";

// POST handler (for custom implementations)
export {
  handleToolsCall,
  handleElicitResponse,
  handleSampleResponse,
  handlePost,
  type PostHandlerOptions,
} from "./post-handler.ts";

// SSE handler (for custom implementations)
export {
  createSseEventStream,
  createSseStreamSetup,
  handleGet,
  type SseStreamOptions,
} from "./get-handler.ts";
