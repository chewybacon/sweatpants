/**
 * lib/chat/session/index.ts
 *
 * Session runtime and types for the chat system.
 * Framework-agnostic - can be used with React, Vue, Svelte, etc.
 */

// Session runtime
export { createChatSession, runChatSession } from "./create-session.ts";
export { ChatSessionRuntimeApi } from "./runtime-api.ts";
export type { ChatRequestPlan, RequestLifecycle } from "./machine.ts";

export type { ChatSession } from "./create-session.ts";

// Streaming
export { streamChatOnce } from "./stream-chat.ts";
export type { StreamChatOptions, ElicitResponseData } from "./options.ts";
export { readDurableHistory, replayFramesToConversation } from "./durable-history.ts";
export type { DurableHistoryReplay } from "./durable-history.ts";

// Transforms
export { useTransformPipeline, passthroughTransform, loggingTransform } from "./transforms.ts";

// Contexts
export { BaseUrlContext } from "./contexts.ts";

// AG-UI checkpoint/projection/messages
export {
  buildAgUiCheckpoint,
  buildAgUiCustomState,
  type BuildAgUiCheckpointOptions,
} from "./ag-ui-checkpoint.ts";
export { providerHistoryMessages, toProviderHistorySnapshot } from "./ag-ui-projection.ts";
export {
  internalMessageToAgUiMessage,
  internalMessagesToAgUiMessages,
  agUiMessageToInternalMessage,
  agUiMessagesToInternalMessages,
  isAgUiMessageArray,
} from "./ag-ui-messages.ts";

// Durable history
export { deduplicateMessages, type DurableFrame } from "./durable-history.ts";

// Message identity
export {
  deriveTurnKeyFromToolCalls,
  turnKeyFromToolCalls,
  messageIdForUser,
  messageIdForAssistantTools,
  messageIdForTool,
  messageIdForAssistantFinal,
  messageIdForSystem,
  assertMessageHasId,
} from "./message-identity.ts";

// Canonical stream and settlement types
export type {
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ElicitRequestStreamEvent,
  StreamEvent,
} from "./streaming.ts";
export type { ChatTransportReceipt, ChatTurnFailure, ChatTurnSettlement } from "./settlement.ts";

// Options and configuration
export type {
  StreamEventEntry,
  ChatFetch,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
} from "./options.ts";
