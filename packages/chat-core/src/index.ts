/**
 * @packageDocumentation
 *
 * @sweatpants/chat-core — chat messages, Turn state, model contracts,
 * personas, and portable codecs.
 *
 * This package owns the protocol-neutral chat domain types that are shared
 * across the durable runtime, UI adapters, and tool runtimes. It does NOT
 * own HTTP hosting, CAS persistence, or MCP server mechanics.
 */

// Core message types
export type {
  Message,
  ToolCall,
  ChatEvent,
  ChatResult,
  ClientToolSchema,
  OllamaChatRequest,
  OllamaChatChunk,
} from "./messages.ts";

// Shared primitives
export type {
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
  ToolCallInfo,
  ServerToolResult,
} from "./core-types.ts";

// Frame protocol
export * from "./frame.ts";

// Persona resolver
export type { PersonaResolver, ResolvedPersona } from "./setup-types.ts";

// Portable stream codecs
export * from "./ndjson.ts";
export * from "./stream.ts";
export * from "./sse.ts";

// Model-provider port and context
export * from "./model-provider.ts";

// History policy
export * from "./history-policy.ts";

// Runtime types (Model, Runtime, Context, StreamOptions, etc.)
// Explicit exports to avoid StreamEvent name collision with session/streaming.ts
export type {
  Runtime,
  ThinkingLevel,
  ThinkingSetting,
  ModelThinkingLevel,
  ThinkingLevelMap,
  ThinkingBudgets,
  Model,
  ImageModel,
  InputModality,
  OutputModality,
  Context,
  Tool,
  Message as RuntimeMessage,
  UserMessage,
  SystemMessage,
  AssistantMessage,
  ToolResultMessage,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ImageBlock,
  StreamEvent as RuntimeStreamEvent,
  ImageGenerationContext,
  AssistantImages,
  StreamOptions,
  ImageGenerationOptions,
  Usage,
  StopReason,
  Cost,
  EventMetadata,
} from "./runtime/index.ts";

// Message part types
export * from "./types/index.ts";

// Personas
export * from "./personas/index.ts";

// Registry interface
export type { McpToolRegistry } from "./registry-types.ts";

// Trace types (tool execution emissions)
export type {
  ComponentTypeLike,
  ComponentEmissionPayload,
  EmissionTraceEntry,
  HydratedEmissionTraceEntry,
  HydratedToolExecutionTrace,
  ToolExecutionTrace,
} from "./trace-types.ts";

// Emission runtime primitives
export {
  createRuntime,
  createComponentHandler,
  getComponentKey,
  COMPONENT_EMISSION_TYPE,
  type Emission,
  type PendingEmission,
  type EmissionHandler,
  type RuntimeConfig,
  type RuntimePrimitive,
} from "./emissions.ts";

// Tool validation error types
export {
  TOOL_PARAMETER_VALIDATION_FAILED,
  type ToolParameterValidationIssue,
  type ToolParameterValidationErrorPayload,
} from "./tool-validation.ts";

// Minimal plugin spec for session options
export type { PluginReplayTraceSpec } from "./plugin-spec.ts";

// Chat state (reducer, timeline, derive)
export {
  chatReducer,
  initialChatState,
  groupTimelineByToolCall,
  deriveMessages,
  deriveCompletedMessages,
  deriveStreamingMessage,
} from "./state/index.ts";
export type {
  ChatState,
  ChatStateEvent,
  LocalChatAction,
  LocalEmissionAction,
  StreamingPartsState,
  ToolEmissionState,
  ToolEmissionTrackingState,
  ElicitState,
  ElicitTrackingState,
  TimelineUserMessage,
  TimelineAssistantText,
  TimelineThinking,
  TimelineToolCall,
  TimelineStep,
  TimelineItem,
  TimelineToolCallGroup,
  GroupedTimelineItem,
  ComponentExtractor,
} from "./state/index.ts";

// Chat session (create, stream, replay, transforms)
export {
  createChatSession,
  runChatSession,
  streamChatOnce,
  readDurableHistory,
  replayFramesToConversation,
  deduplicateMessages,
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
  // AG-UI projection
  buildAgUiCheckpoint,
  buildAgUiCustomState,
  replayActivitySnapshots,
  providerHistoryMessages,
  toProviderHistorySnapshot,
  activitySnapshotsForMessages,
  // AG-UI messages
  internalMessageToAgUiMessage,
  internalMessagesToAgUiMessages,
  agUiMessageToInternalMessage,
  agUiMessagesToInternalMessages,
  isAgUiMessageArray,
  // Message identity
  deriveTurnKeyFromToolCalls,
  turnKeyFromToolCalls,
  messageIdForUser,
  messageIdForAssistantTools,
  messageIdForTool,
  messageIdForAssistantFinal,
  messageIdForSystem,
  assertMessageHasId,
} from "./session/index.ts";
export type {
  ChatSession,
  ClientToolSessionOptions,
  StreamChatOptions,
  ElicitResponseData,
  DurableHistoryReplay,
  DurableFrame,
  PluginReplayTraceSource,
  PluginReplayActivityContent,
  PluginReplayActivitySnapshotEvent,
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ConversationState,
  ConversationReplayToolTrace,
  ConversationReplayState,
  StreamResult,
  StreamCompleteResult,
  StreamElicitResult,
  ElicitRequestStreamEvent,
  StreamEvent as ChatSessionStreamEvent,
  StreamEventEntry,
  ChatFetch,
  Streamer,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
  BuildAgUiCheckpointOptions,
  AgUiFunctionCall,
  AgUiToolCall,
  AgUiMessage,
} from "./session/index.ts";

// Durable chat authoring
export * from "./authoring/index.ts";

// Shared chat-facing tool inventory and runtime contracts.
export * from "./tool-contracts.ts";
export type { DurableEffectRegistration } from "@sweatpants/durable-effects";
