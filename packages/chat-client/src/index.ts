/**
 * @sweatpants/chat-client
 *
 * Headless stateful chat client and optional Effection runtime. This package
 * owns transport/controller lifetimes and pipeline orchestration; pure
 * protocol and projection values come from @sweatpants/chat-core.
 */
export {
  createChatClient,
  type ChatClient,
  type ChatClientOptions,
  type ChatClientControl,
  type ChatTransportOptions,
  type ChatRuntimeOptions,
  type ChatRuntimeControl,
  type ChatSchedulerDriver,
  type ChatInteractionRequest,
  type ChatInteractionCompletion,
  type ChatInteractionRuntime,
  type PipelinePreset,
} from "./client.ts";
export { createChatRuntime, type ChatRuntime } from "./runtime.ts";
export {
  createHttpTransport,
  parseChatResponseStream,
  type ChatFetch,
  type HttpTransportOptions,
} from "./http.ts";
export {
  ChatTransportPort,
  ChatSchedulerPort,
  ChatClientApi,
  ChatEventApi,
  type ChatClientCommandContract,
  type ChatTransportMiddleware,
  type ChatClientMiddleware,
  type ChatEventContract,
  type ChatEventMiddleware,
} from "./ports.ts";
export { ChatClientError, type ChatClientErrorCode } from "./errors.ts";

export type {
  ClientChatMessage as ChatMessage,
  ClientChatPart as ChatPart,
  ChatLocalPart,
  ClientTextPart as TextPart,
  ClientReasoningPart as ReasoningPart,
  ClientToolCallPart as ToolCallPart,
  ClientNestedMessagePart as NestedMessagePart,
  ClientActivityPart as ActivityPart,
  ClientElicitPart as ElicitPart,
  ChatStatus,
  ChatConnectionStatus,
  ChatRenderStatus,
  ChatBusyPolicy,
  ChatQueueOverflowPolicy,
  ChatQueueOptions,
  ChatQueueOption,
  ClientChatSnapshot as ChatSnapshot,
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
  PublicActivityNode,
  PublicActivityPlacement,
  PublicMessageActivityNode,
  PublicToolActivityNode,
  PublicGenericActivityNode,
  PublicElicitActivityNode,
  ClientElicitFact,
  PublicActivityData,
  SweatpantsPublicActivity,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  JsonPatchOperation,
  ChatStreamEvent,
  FramePipeline,
  FramePipelineFactory,
  ChatProjectionAction,
  ChatProjectionTransition,
} from "@sweatpants/chat-core";
export {
  ChatProtocolError,
  decodeChatStreamEvent,
  encodeChatStreamEvent,
  decodePublicActivity,
  validateActivityPatch,
  decodeActivitySnapshotEvent,
  decodeActivityDeltaEvent,
  ChatProjectionError,
  createChatProjection,
  foldChatStreamEvent,
  transitionChatProjection,
  appendChatWireMessage,
  materializeChatMessages,
  updateTextPartFrame,
} from "@sweatpants/chat-core";
export type { ChatProtocolErrorCode, ChatProjectionErrorCode } from "@sweatpants/chat-core";

export * from "./pipeline/index.ts";
