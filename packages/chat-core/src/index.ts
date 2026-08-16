/**
 * @packageDocumentation
 *
 * @sweatpants/chat-core — chat messages, Turn state, personas, and portable codecs.
 * Protocol-neutral model contracts and the provider port live in
 * @sweatpants/model-provider.
 *
 * This package owns the protocol-neutral chat domain types that are shared
 * across the durable runtime, UI adapters, and tool runtimes. It does NOT
 * own HTTP hosting, CAS persistence, or MCP server mechanics.
 */

// Canonical Chat Content
export {
  DEFAULT_CHAT_CONTENT_LIMITS,
  ChatContentDecodeError,
  decodeChatContent,
} from "./content.ts";
export type {
  ChatContent,
  ChatContentPart,
  ChatTextContentPart,
  ChatImageContentPart,
  ChatAudioContentPart,
  ChatVideoContentPart,
  ChatDocumentContentPart,
  ChatContentSource,
  ChatContentDataSource,
  ChatContentUrlSource,
  ChatContentLimits,
  DecodeChatContentOptions,
  ChatContentDecodeErrorCode,
  ChatContentLimitViolation,
} from "./content.ts";

// Canonical first-party Chat semantics.
export {
  ChatMessageDecodeError,
  decodeChatMessage,
  decodeChatMessages,
  decodeChatToolCall,
  decodeChatToolDefinition,
} from "@sweatpants/chat-contract";
export type {
  ChatMessage,
  ChatUserMessage,
  ChatAssistantMessage,
  ChatSystemMessage,
  ChatDeveloperMessage,
  ChatToolResultMessage,
  ChatMessagePart,
  ChatReasoningPart,
  ChatToolCall,
  ChatToolCallPart,
  ChatToolDefinition,
  ChatMessageDecodeErrorCode,
} from "@sweatpants/chat-contract";

// Durable Chat History composes canonical messages.
export {
  ChatHistoryDecodeError,
  chatHistoryEntriesParser,
  chatHistoryEntryParser,
  decodeChatHistoryEntry,
  decodeChatHistoryEntries,
} from "./history.ts";
export type {
  ChatHistoryEntry,
  ChatHistoryMessageEntry,
  ChatHistoryActivityEntry,
  ChatHistoryDecodeErrorCode,
} from "./history.ts";

// AG-UI standard event union remains owned by @ag-ui/core.
export type { AGUIEvent } from "@ag-ui/core";

// Client-safe Chat UI tree and transport contracts.
export type {
  ChatUIMessage,
  ChatUIPart,
  ChatLocalPart,
  ChatUITextPart,
  ChatUIReasoningPart,
  ChatUIStructuredOutputPart,
  ChatUIImagePart,
  ChatUIAudioPart,
  ChatUIVideoPart,
  ChatUIDocumentPart,
  ChatUIMediaPart,
  StructuredOutputStartEvent,
  StructuredOutputCompleteEvent,
  ChatUIToolCallPart,
  ChatUINestedMessagePart,
  ChatUIActivityPart,
  ChatUIElicitPart,
  ChatStatus,
  ChatConnectionStatus,
  ChatRenderStatus,
  ChatBusyPolicy,
  ChatQueueOverflowPolicy,
  ChatQueueOptions,
  ChatQueueOption,
  ChatUISnapshot,
  ChatHistoryError,
  ChatHistoryStatus,
  QueuedUserMessage,
  UserMessageInput,
  SendMessageOptions,
  RegenerateOptions,
  ConversationCommand,
  ResumeEntry,
  ChatTransportRequest,
  ChatReconnectRequest,
  ChatTransportRequestMessage,
  ChatTransportContract,
  ChatTransportSnapshot,
  ChatTransportControl,
  PublicActivityPlacement,
  PublicMessageActivityNode,
  PublicToolActivityNode,
  PublicGenericActivityNode,
  PublicElicitActivityNode,
  ClientElicitFact,
  PublicActivityNode,
  PublicActivityData,
  SweatpantsPublicActivity,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  JsonPatchOperation,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  MessagesSnapshotEvent,
  StateSnapshotEvent,
  StateDeltaEvent,
  TextMessageStartEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ToolCallStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  RawEvent,
  CustomEvent,
  FramePipeline,
  FramePipelineFactory,
} from "./chat-client-types.ts";
export {
  ChatProtocolError,
  activityPatchParser,
  aguiEventParser,
  decodeAGUIEvent,
  encodeAGUIEvent,
  publicActivityParser,
  decodePublicActivity,
  validateActivityPatch,
  decodeActivitySnapshotEvent,
  decodeActivityDeltaEvent,
} from "./chat-client-codec.ts";
export type { ChatProtocolErrorCode } from "./chat-client-codec.ts";
export * from "./conversation-protocol.ts";
export * from "./conversation-window.ts";
export * from "./conversation-stream-validator.ts";
export * from "./conversation-stream-codec.ts";
export * from "./window-projection.ts";
export {
  ChatProjectionError,
  createChatProjection,
  foldAGUIEvent,
  foldAGUIEvents,
  transitionChatProjection,
  appendAGUIMessage,
  appendAGUIMessages,
  materializeChatMessages,
  projectChatMessagesToAGUI,
  updateTextPartFrame,
  findElicitNode,
  findTextParts,
} from "./chat-client-projection.ts";
export type {
  ChatProjectionErrorCode,
  ChatProjectionState,
  ChatProjectionAction,
  ChatProjectionTransition,
} from "./chat-client-projection.ts";

// Shared primitives
export type {
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
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

export {
  CHAT_TURN_COMPLETED_FACT,
  createChatTurnCompletedFact,
  projectChatTurnFacts,
  type ChatTurnHistoryEntry,
} from "./projection-facts.ts";

// History policy
export * from "./history-policy.ts";

// Personas
export * from "./personas/index.ts";

// Registry interface
export type { McpToolRegistry } from "./registry-types.ts";

// Tool validation error types
export {
  TOOL_PARAMETER_VALIDATION_FAILED,
  type ToolParameterValidationIssue,
  type ToolParameterValidationErrorPayload,
} from "@sweatpants/agent-sdk/tool";

// Framework-neutral AG-UI and provider-history projection.
export {
  buildAgUiCustomState,
  providerHistoryEntries,
  toProviderHistorySnapshot,
  deriveTurnKeyFromToolCalls,
  turnKeyFromToolCalls,
  messageIdForUser,
  messageIdForAssistantTools,
  messageIdForTool,
  messageIdForAssistantFinal,
  messageIdForSystem,
  assertMessageHasId,
  ChatConversionError,
  agUiMessageToChatHistoryEntry,
  agUiMessagesToChatHistoryEntries,
  chatHistoryEntryToAgUiMessage,
  chatHistoryEntriesToAgUiMessages,
} from "./ag-ui/index.ts";
export type {
  ChatConversionErrorCode,
  ChatConversionDirection,
  AgUiCustomState,
  AgUiRunMetadata,
  ElicitRequestStreamEvent,
} from "./ag-ui/index.ts";

// Durable chat authoring
export * from "./authoring/index.ts";

// Shared chat-facing tool inventory and runtime contracts.
export * from "./tool-contracts.ts";
export type { DurableEffectRegistration } from "@sweatpants/durable-effects";
