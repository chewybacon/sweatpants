/**
 * lib/chat/types.ts
 *
 * Re-export barrel for chat types. All canonical types are now owned by
 * @sweatpants/chat-core. This barrel preserves the existing import path
 * for framework-internal consumers during the dissolution process.
 */
export type {
  Message,
  ToolCall,
  ChatEvent,
  ChatResult,
  ClientToolSchema,
  OllamaChatRequest,
  OllamaChatChunk,
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
  ToolCallInfo,
  ServerToolResult,
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ConversationState,
  ConversationReplayToolTrace,
  StreamResult,
  StreamCompleteResult,
  Streamer,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
  TimelineUserMessage,
  TimelineAssistantText,
  TimelineThinking,
  TimelineToolCall,
  TimelineStep,
  TimelineItem,
  TimelineToolCallGroup,
  GroupedTimelineItem,
  ChatState,
  ChatStateEvent,
  LocalChatAction,
  LocalEmissionAction,
  ToolEmissionState,
  ToolEmissionTrackingState,
} from "@sweatpants/chat-core";

export { groupTimelineByToolCall, initialChatState } from "@sweatpants/chat-core";
export type {
  ChatSessionStreamEvent as StreamEvent,
  ConversationReplayState,
} from "@sweatpants/chat-core";
