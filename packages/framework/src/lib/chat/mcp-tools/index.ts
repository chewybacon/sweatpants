/**
 * MCP Tools Module
 *
 * Generator-based primitives for authoring MCP (Model Context Protocol) tools.
 *
 * ## Primary API (NEW - use these)
 *
 * - `createMcpTool`: Unified builder with branching, sampling, and elicitation
 *
 * ## Legacy API (DEPRECATED - will be removed)
 *
 * - `createMCPTool`: Original builder with MCPClientContext (simpler, no branching)
 * - `createBranchTool`: Old name for createMcpTool
 *
 * @example Using the primary API
 * ```typescript
 * import { createMcpTool } from '@grove/framework/mcp-tools'
 *
 * const analyze = createMcpTool('analyze')
 *   .description('Analyze with sub-branches')
 *   .parameters(z.object({ input: z.string() }))
 *   .execute(function*(params, ctx) {
 *     // Auto-tracked conversation
 *     const first = yield* ctx.sample({ prompt: 'First step...' })
 *
 *     // Sub-branch for isolated task
 *     const detail = yield* ctx.branch(function* (subCtx) {
 *       return yield* subCtx.sample({ prompt: 'Detail...' })
 *     }, { inheritMessages: false })
 *
 *     return { first: first.text, detail: detail.text }
 *   })
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// PRIMARY API (NEW UNIFIED TYPES AND BUILDER)
// =============================================================================

export { createMcpTool } from './mcp-tool-builder.ts'
export type {
  // Builder interfaces
  McpToolBuilderBase,
  McpToolBuilderWithDescription,
  McpToolBuilderWithParams,
  McpToolBuilderWithElicits,
  FinalizedMcpTool,
  FinalizedMcpToolWithElicits,
  McpToolTypes,
  // Type inference helpers
  InferMcpToolResult,
  InferMcpToolParams,
  InferMcpToolHandoff,
  InferMcpToolClient,
  InferMcpToolElicits,
  // Union types
  AnyMcpTool,
  AnyBridgeableMcpTool,
} from './mcp-tool-builder.ts'

// Types from unified types file
export type {
  // Context types
  McpToolContext,
  McpToolContextWithElicits,
  McpToolServerContext,
  // Handoff configuration
  McpToolHandoffConfig,
  McpToolHandoffConfigWithElicits,
  // Branch options and limits
  McpToolBranchOptions,
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
  // Elicitation types
  ElicitResult,
  RawElicitResult,
  ElicitConfig,
  ElicitsMap,
  ElicitId,
  ElicitRequest,
  // Logging
  LogLevel,
  ModelPreferences,
} from './mcp-tool-types.ts'

// Errors from unified types file
export {
  McpCapabilityError,
  ElicitationDeclinedError,
  ElicitationCancelledError,
  McpToolDepthError,
  McpToolTokenError,
  McpToolTimeoutError,
  McpDisconnectError,
  SampleValidationError,
} from './mcp-tool-types.ts'

// =============================================================================
// LEGACY ALIASES (for backward compatibility during migration)
// Branch* -> McpTool* mapping
// =============================================================================

// Re-export createMcpTool as createBranchTool for backward compatibility
export { createMcpTool as createBranchTool } from './mcp-tool-builder.ts'

// Re-export builder types with legacy names
export type {
  McpToolBuilderBase as BranchToolBuilderBase,
  McpToolBuilderWithDescription as BranchToolBuilderWithDescription,
  McpToolBuilderWithParams as BranchToolBuilderWithParams,
  McpToolBuilderWithElicits as BranchToolBuilderWithElicits,
  FinalizedMcpTool as FinalizedBranchTool,
  FinalizedMcpToolWithElicits as FinalizedBranchToolWithElicits,
  McpToolTypes as BranchToolTypes,
  InferMcpToolResult as InferBranchResult,
  InferMcpToolParams as InferBranchParams,
  InferMcpToolHandoff as InferBranchHandoff,
  InferMcpToolClient as InferBranchClient,
  InferMcpToolElicits as InferBranchElicits,
  AnyMcpTool as AnyBranchTool,
  AnyBridgeableMcpTool as AnyBridgeableBranchTool,
} from './mcp-tool-builder.ts'

// Re-export context/config types with legacy names
export type {
  McpToolContext as BranchContext,
  McpToolContextWithElicits as BranchContextWithElicits,
  McpToolServerContext as BranchServerContext,
  McpToolHandoffConfig as BranchHandoffConfig,
  McpToolHandoffConfigWithElicits as BranchHandoffConfigWithElicits,
  McpToolBranchOptions as BranchOptions,
  McpToolLimits as BranchLimits,
  McpToolSampleConfig as BranchSampleConfig,
} from './mcp-tool-types.ts'

// Re-export errors with legacy names
export {
  McpToolDepthError as BranchDepthError,
  McpToolTokenError as BranchTokenError,
  McpToolTimeoutError as BranchTimeoutError,
} from './mcp-tool-types.ts'

// =============================================================================
// ORIGINAL MCP BUILDER (simpler, no sub-branching) - DEPRECATED
// =============================================================================

export { createMCPTool } from './builder.ts'
export type {
  MCPToolBuilderBase,
  MCPToolBuilderWithDescription,
  MCPToolBuilderWithParams,
  FinalizedMCPTool,
  MCPToolTypes,
  InferMCPResult,
  InferMCPParams,
  InferMCPHandoff,
  InferMCPClient,
} from './builder.ts'

// Original types
export type {
  MCPClientContext,
  MCPServerContext,
  MCPHandoffConfig,
  MCPToolDef,
  AnyMCPTool,
  // Note: ElicitResult and ElicitConfig are already exported from mcp-tool-types
  // These are aliases for backward compat
  // ElicitResult,
  // ElicitConfig,
  SampleConfig,
  // ModelPreferences already exported above
  // LogLevel already exported above
  InferMCPToolParams,
  InferMCPToolResult,
  InferMCPToolHandoff,
  InferMCPToolClient,
} from './types.ts'

// Legacy errors (shared) - keep for compatibility
export {
  MCPCapabilityError,
  // ElicitationDeclinedError already exported above
  // ElicitationCancelledError already exported above
  MCPTimeoutError,
  MCPDisconnectError,
} from './types.ts'

// Original mock runtime
export {
  createMockMCPClient,
  runMCPTool,
  runMCPToolOrThrow,
} from './mock-runtime.ts'
export type {
  MockMCPClient,
  MockMCPClientConfig,
  RunMCPToolOptions,
} from './mock-runtime.ts'

// =============================================================================
// BRANCH RUNTIME (uses new types internally)
// =============================================================================

export { runBranchTool } from './branch-runtime.ts'
export type {
  BranchMCPClient,
  RunBranchToolOptions,
} from './branch-runtime.ts'

// Branch mock runtime
export {
  createMockBranchClient,
  runBranchToolMock,
} from './branch-mock.ts'
export type {
  MockBranchClient,
  MockBranchClientConfig,
} from './branch-mock.ts'

// =============================================================================
// PLUGIN SYSTEM (bridgeable tools -> framework-native plugins)
// =============================================================================

export { makePlugin } from './plugin.ts'
export type {
  McpPlugin,
  PluginBuilder,
  PluginBuilderWithHandlers,
  PluginServerRegistration,
  PluginClientRegistration,
  PluginClientContext,
  ElicitHandler,
  ElicitHandlers,
  InferPluginElicits,
  InferPluginTool,
  AnyMcpPlugin,
  // Re-export renderable types for plugin authors
  RenderableProps,
  UserProps,
  ExtractResponse,
} from './plugin.ts'

// Plugin execution
export {
  createPluginClientContext,
  executePluginElicitHandler,
  executePluginElicitHandlerFromRequest,
} from './plugin-executor.ts'
export type {
  CreatePluginClientContextOptions,
  PluginContextForKey,
} from './plugin-executor.ts'

// Plugin registry
export {
  createPluginRegistry,
  createPluginRegistryFrom,
} from './plugin-registry.ts'
export type {
  PluginRegistry,
} from './plugin-registry.ts'

// =============================================================================
// BRIDGE RUNTIME (in-app tool execution with UI elicitation)
// =============================================================================

export {
  createBridgeHost,
  runBridgeTool,
  BranchElicitNotAllowedError,
} from './bridge-runtime.ts'
export type {
  BridgeHost,
  BridgeHostConfig,
  BridgeEvent,
  BridgeSamplingProvider,
  BridgeSampleOptions,
  BridgeElicitHandlers,
  ElicitResponse,
} from './bridge-runtime.ts'

// =============================================================================
// DURABLE TOOL SESSIONS (HTTP-friendly, survives request boundaries)
// =============================================================================

export {
  // Session creation
  createToolSession,
  
  // Registry for managing sessions
  createToolSessionRegistry,
  
  // In-memory store implementation
  createInMemoryToolSessionStore,
  createInMemoryToolSessionStoreWithDebug,
  
  // Setup and contexts
  setupToolSessions,
  ToolSessionStoreContext,
  ToolSessionRegistryContext,
  ToolSessionSamplingProviderContext,
  useToolSessionStore,
  useToolSessionRegistry,
  useToolSessionSamplingProvider,
  useOptionalToolSessionStore,
  useOptionalToolSessionRegistry,
  useOptionalToolSessionSamplingProvider,
} from './session/index.ts'

export type {
  // Session types
  ToolSession,
  ToolSessionStatus,
  ToolSessionOptions,
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
  
  // Options
  ToolSessionRegistryOptions,
  SetupToolSessionsOptions,
} from './session/index.ts'

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
} from './protocol/index.ts'

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
} from './protocol/index.ts'

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
} from './model-context.ts'

export type {
  EncodeElicitContextOptions,
  EncodedElicitContext,
  ExtractedModelContext,
} from './model-context.ts'

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
} from './handler/index.ts'

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
} from './handler/index.ts'
