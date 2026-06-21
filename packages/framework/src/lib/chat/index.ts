// Types
export * from './types.ts'
export * from './types/index.ts'
export * from './frame.ts'
export type { IsomorphicTool, PersonaResolver, ResolvedPersona } from './setup-types.ts'

// Stream utilities
export * from './ndjson.ts'
export * from './stream.ts'
export * from './sse.ts'

// Scope-driven driver contracts and APIs.
export * from './model-provider.ts'
export * from './tool-inventory.ts'
export * from './tool-runtime.ts'

// Scope-driven chat setup contexts.
export {
  ToolRegistryContext,
  PersonaResolverContext,
  MaxIterationsContext,
  PluginRegistryContext,
  McpToolRegistryContext,
  PluginSessionStoreContext,
  PluginSessionRegistryContext,
  PluginSessionManagerContext,
} from './contexts.ts'

export * from './personas/index.ts'

// Browser-safe session/state/patch contracts used by UI adapters.
export {
  createChatSession,
  runChatSession,
  streamChatOnce,
  readDurableHistory,
  replayFramesToConversation,
  useTransformPipeline,
  passthroughTransform,
  loggingTransform,
  BaseUrlContext,
  StreamerContext,
  ToolRegistryContext as ClientToolRegistryContext,
} from './session/index.ts'
export type {
  ChatSession,
  ClientToolSessionOptions,
  HandoffResponseSignalValue,
  StreamChatOptions,
  ElicitResponseData,
  DurableHistoryReplay,
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ConversationState,
  ConversationReplayToolTrace,
  StreamResult,
  StreamCompleteResult,
  StreamIsomorphicHandoffResult,
  StreamElicitResult,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  ElicitRequestStreamEvent,
  ToolSessionStatusStreamEvent,
  ToolSessionErrorStreamEvent,
  StreamEvent as ChatSessionStreamEvent,
  StreamEventEntry,
  Streamer,
  MessageRenderer,
  PatchTransform,
  SessionOptions,
  ChatCommand,
} from './session/index.ts'
export {
  initialChatState,
  chatReducer,
  groupTimelineByToolCall,
  deriveMessages,
  deriveStreamingMessage,
} from './state/index.ts'
export type {
  ChatState,
  PendingClientToolState,
  StreamingPartsState,
  ToolEmissionState,
  ToolEmissionTrackingState,
  ElicitState,
  ElicitTrackingState,
} from './state/index.ts'
export {
  isEmissionPatch,
  isElicitPatch,
} from './patches/index.ts'
export type {
  ChatPatch,
  ContentPartType,
  PartFramePatch,
  PartEndPatch,
  EmissionPatch,
  ToolEmissionStartPatch,
  ToolEmissionPatch,
  ToolEmissionResponsePatch,
  ToolEmissionCompletePatch,
  ElicitStartPatch,
  ElicitPatch,
  ElicitResponsePatch,
  ElicitCompletePatch,
  ElicitPatchUnion,
} from './patches/index.ts'
export {
  createPluginRegistry,
  createPluginRegistryFrom,
} from './mcp-tools/plugin-registry.ts'
export type { PluginRegistry } from './mcp-tools/plugin-registry.ts'
export { executeElicitHandlerFromRequest } from './mcp-tools/plugin-executor.ts'
export type { PendingHandoff, ToolHandlerRegistry } from './isomorphic-tools/index.ts'

// Model context utilities (browser-safe subset of mcp-tools)
export { stripMessageContext, getElicitContext, MODEL_CONTEXT_SCHEMA_KEY } from './mcp-tools/model-context.ts'

// MCP tool builder (browser-safe - only types, no Node.js deps)
export { createMcpTool } from './mcp-tools/mcp-tool-builder.ts'

export type { IsomorphicToolSchema } from './isomorphic-tools/index.ts'

// Sample result types for structured output and tool calling
export type {
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SamplingToolCall,
  SamplingToolDefinition,
  SamplingToolChoice,
  // Extended message type for conversation history
  ExtendedMessage,
  // MCP message types for tool interactions
  McpMessage,
  McpContentBlock,
  McpTextContent,
  McpToolUseContent,
  McpToolResultContent,
  // Exchange types for history accumulation
  ElicitExchange,
  SampleExchange,
  ElicitRequest,
  ElicitId,
} from './mcp-tools/mcp-tool-types.ts'

// Plugin builder (browser-safe)
export { makePlugin } from './mcp-tools/plugin.ts'
export type {
  McpPlugin,
  PluginBuilder,
  PluginBuilderWithHandlers,
  PluginServerRegistration,
  PluginClientRegistration,
  PluginClientRegistrationInput,
  PluginClientContext,
  ElicitHandler,
  ElicitHandlers,
  InferElicits,
  InferPluginTool,
  AnyMcpPlugin,
  RenderableProps,
  UserProps,
  ExtractResponse,
} from './mcp-tools/plugin.ts'

// Logger
export {
  type Logger,
  type LoggerFactory,
  useLogger,
  setupLogger,
  createPinoLoggerFactory,
  createNoopLogger,
  LoggerFactoryContext,
  type PinoLoggerOptions,
} from '../logger/index.ts'

