// Types
export * from "./types.ts";
export * from "./types/index.ts";
export * from "./frame.ts";
export type { PersonaResolver, ResolvedPersona } from "./setup-types.ts";

// Stream utilities
export * from "./ndjson.ts";
export * from "./stream.ts";
export * from "./sse.ts";

// Scope-driven driver contracts and APIs.
export * from "./model-provider.ts";
export type { AssistantMessage, Model } from "./runtime/index.ts";
export * from "./tool-inventory.ts";
export * from "./tool-runtime.ts";
export * from "./tool-parameters.ts";

// Scope-driven chat setup contexts.
export {
  PersonaResolverContext,
  MaxIterationsContext,
  PluginRegistryContext,
  McpToolRegistryContext,
  PluginSessionStoreContext,
  PluginSessionRegistryContext,
  PluginSessionManagerContext,
} from "./contexts.ts";

export * from "./personas/index.ts";

// Browser-safe session/state/patch contracts used by UI adapters.
export {
  createChatSession,
  runChatSession,
  streamChatOnce,
  readDurableHistory,
  replayFramesToConversation,
  PLUGIN_REPLAY_ACTIVITY_TYPE,
  PLUGIN_REPLAY_LIMITS,
  normalizeClientReplayTrace,
  mergePluginReplayTrace,
  buildPluginReplayActivity,
  activityMessageToPluginReplayTrace,
  activitySnapshotToPluginReplayTrace,
  useTransformPipeline,
  passthroughTransform,
  loggingTransform,
  BaseUrlContext,
  StreamerContext,
} from "./session/index.ts";
export type {
  ChatSession,
  ClientToolSessionOptions,
  StreamChatOptions,
  ElicitResponseData,
  DurableHistoryReplay,
  PluginReplayTraceSource,
  PluginReplayActivityContent,
  PluginReplayActivitySnapshotEvent,
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ConversationState,
  ConversationReplayToolTrace,
  StreamResult,
  StreamCompleteResult,
  StreamElicitResult,
  ConversationStateStreamEvent,
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
} from "./session/index.ts";
export {
  initialChatState,
  chatReducer,
  groupTimelineByToolCall,
  deriveMessages,
  deriveStreamingMessage,
} from "./state/index.ts";
export type {
  ChatState,
  PendingClientToolState,
  StreamingPartsState,
  ToolEmissionState,
  ToolEmissionTrackingState,
  ElicitState,
  ElicitTrackingState,
} from "./state/index.ts";
export { isEmissionPatch, isElicitPatch } from "./patches/index.ts";
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
} from "./patches/index.ts";
export { createPluginRegistry, createPluginRegistryFrom } from "./mcp-tools/plugin-registry.ts";
export type { PluginRegistry } from "./mcp-tools/plugin-registry.ts";
export { executeElicitHandlerFromRequest } from "./mcp-tools/plugin-executor.ts";
// Model context utilities (browser-safe subset of mcp-tools)
export {
  stripMessageContext,
  getElicitContext,
  MODEL_CONTEXT_SCHEMA_KEY,
} from "./mcp-tools/model-context.ts";

// Canonical core tool types. Author tools with createTool from @sweatpants/core.
export type {
  ToolDefinition as CoreToolDefinition,
  ToolCtx,
  ElicitExchange as CoreElicitExchange,
  SampleExchange as CoreSampleExchange,
  SampleRequest as CoreSampleRequest,
  ToolExtension,
  ToolExtensionMetadata,
} from "@sweatpants/core";

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
} from "./mcp-tools/mcp-tool-types.ts";

// Plugin builder (browser-safe)
export { makePlugin } from "./mcp-tools/plugin.ts";
export * from "./browser-rendering/index.ts";
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
  PluginHandleInput,
  RenderableProps,
  UserProps,
  ExtractResponse,
} from "./mcp-tools/plugin.ts";

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
} from "../logger/index.ts";
