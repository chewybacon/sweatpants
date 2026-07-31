/**
 * lib/chat/session/index.ts
 *
 * Session runtime and types for the chat system.
 * Framework-agnostic - can be used with React, Vue, Svelte, etc.
 */

// Session runtime
export { createChatSession, runChatSession } from "./create-session.ts";

export type { ChatSession, ClientToolSessionOptions } from "./create-session.ts";

// Streaming
export { streamChatOnce } from "./stream-chat.ts";
export type { StreamChatOptions, ElicitResponseData } from "./options.ts";
export { readDurableHistory, replayFramesToConversation } from "./durable-history.ts";
export type { DurableHistoryReplay } from "./durable-history.ts";
export {
  PLUGIN_REPLAY_ACTIVITY_TYPE,
  PLUGIN_REPLAY_LIMITS,
  normalizeClientReplayTrace,
  mergePluginReplayTrace,
  buildPluginReplayActivity,
  activityMessageToPluginReplayTrace,
  activitySnapshotToPluginReplayTrace,
} from "./plugin-replay.ts";
export type {
  PluginReplayTraceSource,
  PluginReplayActivityContent,
  PluginReplayActivitySnapshotEvent,
} from "./plugin-replay.ts";

// Transforms
export { useTransformPipeline, passthroughTransform, loggingTransform } from "./transforms.ts";

// Contexts
export { BaseUrlContext, StreamerContext } from "./contexts.ts";

// AG-UI checkpoint/projection/messages
export {
  buildAgUiCheckpoint,
  buildAgUiCustomState,
  type BuildAgUiCheckpointOptions,
} from "./ag-ui-checkpoint.ts";
export {
  replayActivitySnapshots,
  providerHistoryMessages,
  toProviderHistorySnapshot,
  activitySnapshotsForMessages,
} from "./ag-ui-projection.ts";
export {
  internalMessageToAgUiMessage,
  internalMessagesToAgUiMessages,
  agUiMessageToInternalMessage,
  agUiMessagesToInternalMessages,
  isAgUiMessageArray,
  type AgUiFunctionCall,
  type AgUiToolCall,
  type AgUiMessage,
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
  ConversationReplayToolTrace,
  ConversationReplayState,
  ElicitRequestStreamEvent,
  StreamEvent,
} from "./streaming.ts";
export type { ChatTransportReceipt, ChatTurnSettlement } from "./settlement.ts";

// Options and configuration
export type {
  StreamEventEntry,
  ChatFetch,
  Streamer,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
} from "./options.ts";
