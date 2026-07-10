/**
 * MCP Tools Module
 *
 * MCP adapter/runtime utilities for canonical core tools.
 *
 * Tool authoring is owned by `@sweatpants/core`:
 *
 * ```typescript
 * import { createTool } from '@sweatpants/core/tools'
 *
 * const analyze = createTool('analyze')
 *   .description('Analyze input')
 *   .parameters(z.object({ input: z.string() }))
 *   .samples()
 *   .execute(function*(params, ctx) {
 *     const first = yield* ctx.sample({ prompt: `Analyze ${params.input}` })
 *     return { text: first.text }
 *   })
 * ```
 *
 * This module exposes MCP projection, protocol, plugin, and execution helpers.
 * It no longer publicly exports MCP-specific tool builders.
 *
 * @packageDocumentation
 */

// =============================================================================
// CANONICAL CORE TOOL TYPES
// =============================================================================

export type {
  ToolDefinition,
  RuntimeTool,
  ToolCtx,
  ElicitExchange as CoreElicitExchange,
  SampleExchange as CoreSampleExchange,
  SampleRequest as CoreSampleRequest,
} from "@sweatpants/core";

// Types from unified types file
export type {
  // Execution limits
  McpToolLimits,
  // Sample types
  McpToolSampleConfig,
  SampleConfigPrompt,
  SampleConfigMessages,
  SampleResult,
  // Sample result types (for schema/tools)
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  WireSampleResult,
  WireSampleResultBase,
  WireSampleResultWithParsed,
  WireSampleResultWithToolCalls,
  // Sample helper types (guaranteed results)
  SampleToolsConfig,
  SampleToolsConfigMessages,
  SampleSchemaConfig,
  SampleSchemaConfigMessages,
  SampleToolsResult,
  SampleSchemaResult,
  // Sampling tool types
  SamplingToolDefinition,
  SamplingToolCall,
  SamplingToolChoice,
  // Message types
  Message,
  MessageRole,
  ExtendedMessage,
  ToolCallMessage,
  ToolResultMessage,
  // Elicitation types
  ToolElicitResult,
  WireElicitResult,
  ClientElicitConfig,
  ElicitsMap,
  ElicitId,
  ElicitRequest,
  // Logging
  LogLevel,
  ModelPreferences,
} from "./mcp-tool-types.ts";

// Errors from unified types file
export {
  McpCapabilityError,
  ElicitationDeclinedError,
  ElicitationCancelledError,
  McpToolTokenError,
  McpToolTimeoutError,
  McpDisconnectError,
  SampleValidationError,
  // Sample exchange helpers
  SCHEMA_TOOL_NAME,
  createRawSampleExchange,
  createStructuredSampleExchange,
} from "./mcp-tool-types.ts";

// Mock runtime helpers for adapter tests.
export { createMockMCPClient, runMCPTool } from "./mock-runtime.ts";
export type { MockMCPClient, MockMCPClientConfig, RunMCPToolOptions } from "./mock-runtime.ts";
export {
  projectCoreElicitExchangeToMcpMessages,
  projectCoreSampleExchangeToMcpMessages,
  projectCoreInteractionExchangeToMcpMessages,
  projectCoreExchangesToMcpMessages,
} from "./core-exchange-projection.ts";

// =============================================================================
// PLUGIN SYSTEM (bridgeable tools -> framework-native plugins)
// =============================================================================

export { makePlugin } from "./plugin.ts";
export type {
  McpPlugin,
  PluginBuilder,
  PluginBuilderWithHandlers,
  PluginServerRegistration,
  PluginClientRegistration,
  PluginClientContext,
  ElicitHandler,
  ElicitHandlers,
  InferElicits,
  InferPluginTool,
  AnyMcpPlugin,
  PluginHandleInput,
  // Re-export renderable types for plugin authors
  RenderableProps,
  UserProps,
  ExtractResponse,
} from "./plugin.ts";

// Plugin execution
export {
  createPluginClientContext,
  executeElicitHandler,
  executeElicitHandlerFromRequest,
} from "./plugin-executor.ts";
export type { CreatePluginClientContextOptions, PluginContextForKey } from "./plugin-executor.ts";

// Plugin registry
export { createPluginRegistry, createPluginRegistryFrom } from "./plugin-registry.ts";
export type { PluginRegistry } from "./plugin-registry.ts";

// =============================================================================
// BRIDGE RUNTIME (in-app tool execution with UI elicitation)
// =============================================================================

export { createBridgeHost, runBridgeTool } from "./bridge-runtime.ts";
export type {
  BridgeHost,
  BridgeHostConfig,
  BridgeEvent,
  BridgeSamplingProvider,
  BridgeSampleOptions,
  BridgeElicitHandlers,
  ElicitResponse,
  SampleResponse,
} from "./bridge-runtime.ts";

// =============================================================================
// DURABLE TOOL SESSIONS (HTTP-friendly, survives request boundaries)
// =============================================================================

export {
  ToolSessionStoreContext,
  ToolSessionRegistryContext,
  ToolSessionSamplingProviderContext,
  useToolSessionStore,
  useToolSessionRegistry,
  useToolSessionSamplingProvider,
  useOptionalToolSessionStore,
  useOptionalToolSessionRegistry,
  useOptionalToolSessionSamplingProvider,
} from "./session/contexts.ts";

export { adaptToolSessionToSessionContract } from "./session/contract-adapter.ts";

export type {
  // Session types
  ToolSession,
  ToolSessionStatus,
  ToolSessionOptions,
  ToolSessionModelSelection,
  ToolSessionEntry,

  // Event types
  ToolSessionEvent,
  ProgressEvent,
  LogEvent,
  ElicitRequestEvent,
  SampleRequestEvent,
  ResultEvent,
  ErrorEvent,
  CancelledEvent,

  // Registry and store
  ToolSessionRegistry,
  ToolSessionStore,
  ToolSessionSamplingProvider,

  // Type helpers
  InferToolSessionResult,
  AnyToolSession,
} from "./session/types.ts";

// =============================================================================
// MCP PROTOCOL (JSON-RPC encoding/decoding, SSE formatting)
// =============================================================================

export {
  // Encoder
  encodeSessionEvent,
  createEncoderContext,
  encodeProgressNotification,
  encodeLogNotification,
  encodeElicitationRequest,
  encodeSamplingRequest,
  encodeToolCallResult,
  encodeToolCallError,
  encodeToolCallCancelled,

  // Decoder
  decodeElicitationResponse,
  decodeSamplingResponse,
  decodeToolCallRequest,
  decodeResponse,
  createDecoderContext,
  parseJsonRpcMessage,
  validateToolCallRequest,
  validateElicitationResponse,
  validateSamplingResponse,

  // SSE
  formatSseEvent,
  formatMessageAsSse,
  parseSseEvent,
  parseSseChunk,
  generateEventId,
  parseEventId,
  createPrimeEvent,
  createCloseEvent,
  createSseHeaders,
  createSseWriter,

  // Type guards
  isJsonRpcError,
  isJsonRpcSuccess,
  isTextContent,
  isToolUseContent,
  isToolResultContent,

  // Error codes
  JSON_RPC_ERROR_CODES,
  MCP_ERROR_CODES,
} from "./protocol/index.ts";

export {
  extendedMessageToProviderMessage,
  isToolCallMessage,
  isToolResultMessage,
} from "./message-conversion.ts";

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
  McpElicitationParams,
  McpElicitationResult,

  // Notification types
  McpProgressParams,
  McpLogLevel,
  McpMessageParams,

  // Tool types
  McpToolCallParams,
  McpToolCallResult,

  // SSE types
  SseEvent,
  SseWriter,

  // Encoder/decoder types
  EncoderContext,
  EncodedMessage,
  DecodedMessage,
  DecoderContext,
  PendingRequest,
  ParsedJsonRpcMessage,
} from "./protocol/index.ts";

// =============================================================================
// MODEL CONTEXT TRANSPORT (x-model-context for elicitation context data)
// =============================================================================

export {
  // Encoding/decoding
  encodeElicitContext,
  extractModelContext,
  parseMessageContext,
  stripMessageContext,

  // Helper for plugin authors
  getElicitContext,

  // Constants
  MODEL_CONTEXT_SCHEMA_KEY,
  MODEL_CONTEXT_BOUNDARY,
  MODEL_CONTEXT_MIME_TYPE,
} from "./model-context.ts";

export type {
  EncodeElicitContextOptions,
  EncodedElicitContext,
  ExtractedModelContext,
} from "./model-context.ts";

// =============================================================================
// MCP HTTP HANDLER (Streamable HTTP transport)
// =============================================================================

export {
  // Main factory
  createMcpHandler,

  // Session manager
  createSessionManager,
  McpSessionManager,
  McpSessionManagerContext,

  // Request parsing
  parseHeaders,
  validatePostHeaders,
  validateGetHeaders,
  parseRequest,
  classifyRequest,
  parseAndClassify,

  // POST handling
  handleToolsCall,
  handleElicitResponse,
  handleSampleResponse,
  handlePost,

  // SSE streaming
  createSseEventStream,
  createSseStreamSetup,
  handleGet,

  // Error handling
  McpHandlerError,
  MCP_HANDLER_ERRORS,
} from "./handler/index.ts";

export type {
  // Config
  McpHandlerConfig,
  McpHandlerOptions,
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

  // Response types
  McpPostResult,

  // Session state
  McpSessionState,
  PendingElicitation,
  PendingSample,
  McpSessionManagerOptions,

  // Handler options
  PostHandlerOptions,
  SseStreamOptions,

  // Error types
  McpHandlerErrorCode,
} from "./handler/index.ts";
