// Types — chat-core owns messages, core-types, frame, personas, codecs, model-provider, runtime types
export * from "./types.ts";

// Re-export chat-core-owned types and utilities (explicit names for tsup compatibility)
export type {
  Annotation,
  RenderPass,
  BlockStatus,
  BlockType,
  Block,
  TraceAction,
  TraceEntry,
  Frame,
  ProcessFn,
  Processor,
  ProcessorPreset,
  PipelineConfig,
  FrameEmitter,
  PipelineResult,
  ParseContext,
  Parser,
  ParserFactory,
  ResolvedProcessors,
} from "@sweatpants/chat-core";

export type {
  ChatEmission,
  ChatMessage,
  StreamingMessage,
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  MessagePart,
  ContentPart,
  PluginElicit,
} from "@sweatpants/chat-core";
export {
  generatePartId,
  resetPartIdCounter,
  createTextPart,
  createReasoningPart,
  createToolCallPart,
  createToolResultPart,
  getRenderedFromFrame,
  isContentPart,
  getMessageTextContent,
  getMessageReasoningContent,
  getMessageToolCalls,
} from "@sweatpants/chat-core";

export type { PersonaResolver, ResolvedPersona } from "@sweatpants/chat-core";
export type { McpToolRegistry } from "@sweatpants/chat-core";

export { parseNDJSON, type ParseNDJSONOptions } from "@sweatpants/chat-core";
export { consumeAsync } from "@sweatpants/chat-core";
export { parseSSE, type SSEEvent } from "@sweatpants/chat-core";

export {
  ModelProviderPort,
  ModelProviderApi,
  installModelProvider,
  ModelProviderModelContext,
  ModelProviderStreamOptionsContext,
  useModel,
  useStreamOptions,
  type ModelProviderStreamRequest,
  type ModelProviderSampleRequest,
  type ModelProviderDriver,
  ModelProviderUnavailable,
} from "@sweatpants/chat-core";

export {
  HistoryPolicyContext,
  applyHistoryPolicy,
  createMessageBudgetHistoryPolicy,
  type HistoryPolicyDecision,
  type HistoryPolicyInput,
  type HistoryPolicyResult,
  type HistoryPolicy,
  type MessageBudgetHistoryPolicyOptions,
} from "@sweatpants/chat-core";

export type { AssistantMessage, Model } from "@sweatpants/chat-core";

export {
  definePersona,
  personas,
  resolvePersona,
  getPersonaManifest,
  type PersonaName,
} from "@sweatpants/chat-core";

// Digest-covered protocol-neutral durable chat authoring (owned by chat-core).
export {
  CHAT_CONTEXT_POLICY_DOMAIN,
  CHAT_INPUT_ENVELOPE_RESERVE_BYTES,
  DEFAULT_CHAT_CONTEXT_LIMITS,
  acceptChatTurn,
  chatPayloadClassifications,
  latestContextWindow,
  selectChatContext,
  CHAT_CONTEXT_POLICY_FORMAT,
  CHAT_CONTRACT_SCHEMA_ENTRIES,
  CHAT_TURN_INPUT_DESCRIPTOR,
  CHAT_TURN_INPUT_FORMAT,
  CHAT_TURN_RESULT_DESCRIPTOR,
  CHAT_TURN_RESULT_FORMAT,
  normalizeChatMessage,
  normalizeChatTurnInput,
  normalizeChatTurnResult,
  normalizeContentPart,
  normalizeModelSampleOutput,
  CHAT_MODEL_SAMPLE_EFFECT,
  CHAT_PROGRAM_IDENTITY_DOMAIN,
  GENERIC_CHAT_ENGINE,
  classifiedToolResult,
  createChatModelEffectRegistration,
  defineChatProgram,
  modelReadable,
  modelTool,
  programPrivate,
  toolScoped,
} from "@sweatpants/chat-core";
export type {
  ChatContextSelectionInput,
  ChatArtifactV1,
  ChatContentPartV1,
  ChatContextPolicyV1,
  ChatContextViewV1,
  ChatMessageV1,
  ChatModelSampleInputV2,
  ChatModelSampleOutputV2,
  ChatModelToolCallV1,
  ChatTurnInputV1,
  ChatTurnResultV1,
  ReferencedTaskSummaryV1,
  ChatModelToolDeclaration,
  ChatProgramDefinition,
  ChatResourceMountDeclaration,
  ClassifiedToolResultV1,
  ChatSamplingPolicyV1,
  ChatSystemPrompt,
  DefineChatProgramOptions,
} from "@sweatpants/chat-core";
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

// Personas now owned by chat-core (re-exported above via export * from "@sweatpants/chat-core")

// Session/state contracts now owned by chat-core (re-exported above and below)
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
  initialChatState,
  chatReducer,
  deriveMessages,
  deriveStreamingMessage,
} from "@sweatpants/chat-core";
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
  ElicitRequestStreamEvent,
  ChatSessionStreamEvent,
  StreamEventEntry,
  ChatFetch,
  Streamer,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
  ChatState,
  ChatStateEvent,
  LocalChatAction,
  LocalEmissionAction,
  StreamingPartsState,
  ToolEmissionState,
  ToolEmissionTrackingState,
  ElicitState,
  ElicitTrackingState,
} from "@sweatpants/chat-core";
export { createPluginRegistry, createPluginRegistryFrom } from "./mcp-tools/plugin-registry.ts";
export type { PluginRegistry } from "./mcp-tools/plugin-registry.ts";
export { executeElicitHandlerFromRequest } from "./mcp-tools/plugin-executor.ts";
// Model context utilities (browser-safe subset of mcp-tools)
export { getElicitContext, MODEL_CONTEXT_SCHEMA_KEY } from "./mcp-tools/model-context.ts";

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
