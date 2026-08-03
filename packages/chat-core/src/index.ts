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

// Core message types
export type { Message, ChatEvent, ChatResult } from "./messages.ts";

// Headless client protocol and nested message model. These names are aliased
// here because the pre-release legacy message authoring types remain internal
// to the old session implementation while the new client package owns the
// public aliases.
export type {
  ChatMessage as ClientChatMessage,
  ChatPart as ClientChatPart,
  ChatLocalPart,
  TextPart as ClientTextPart,
  ReasoningPart as ClientReasoningPart,
  ToolCallPart as ClientToolCallPart,
  NestedMessagePart as ClientNestedMessagePart,
  ActivityPart as ClientActivityPart,
  ElicitPart as ClientElicitPart,
  ChatStatus,
  ChatConnectionStatus,
  ChatRenderStatus,
  ChatSnapshot as ClientChatSnapshot,
  QueuedUserMessage,
  UserInputPart,
  UserMessageInput,
  SendMessageOptions,
  RegenerateOptions,
  ChatSendTrigger,
  ResumeEntry,
  ChatSendRequest,
  ChatReconnectRequest,
  ChatWireMessage,
  ChatRequestMessage,
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
  ChatStreamEvent,
  FramePipeline,
  FramePipelineFactory,
} from "./chat-client-types.ts";
export {
  ChatProtocolError,
  decodeChatStreamEvent,
  encodeChatStreamEvent,
  decodePublicActivity,
  validateActivityPatch,
  decodeActivitySnapshotEvent,
  decodeActivityDeltaEvent,
} from "./chat-client-codec.ts";
export type { ChatProtocolErrorCode } from "./chat-client-codec.ts";
export {
  ChatProjectionError,
  createChatProjection,
  foldChatStreamEvent,
  transitionChatProjection,
  appendChatWireMessage,
  materializeChatMessages,
  projectChatMessagesToWire,
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
  buildAgUiCheckpoint,
  buildAgUiCustomState,
  providerHistoryMessages,
  toProviderHistorySnapshot,
  internalMessageToAgUiMessage,
  internalMessagesToAgUiMessages,
  agUiMessageToInternalMessage,
  agUiMessagesToInternalMessages,
  isAgUiMessageArray,
  deriveTurnKeyFromToolCalls,
  turnKeyFromToolCalls,
  messageIdForUser,
  messageIdForAssistantTools,
  messageIdForTool,
  messageIdForAssistantFinal,
  messageIdForSystem,
  assertMessageHasId,
} from "./ag-ui/index.ts";
export type {
  DurableFrame,
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ElicitRequestStreamEvent,
  StreamEvent as ChatSessionStreamEvent,
  BuildAgUiCheckpointOptions,
} from "./ag-ui/index.ts";

// Durable chat authoring
export * from "./authoring/index.ts";

// Shared chat-facing tool inventory and runtime contracts.
export * from "./tool-contracts.ts";
export type { DurableEffectRegistration } from "@sweatpants/durable-effects";
