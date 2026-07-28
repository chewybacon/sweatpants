/**
 * lib/chat/types.ts
 *
 * Re-export barrel for chat types. Types owned by @sweatpants/chat-core
 * are re-exported from that package. Types owned by session/state modules
 * (which remain in framework until later dissolution stages) are re-exported
 * from their canonical files.
 */

// Re-export chat-core-owned types
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
} from "@sweatpants/chat-core";

export type {
  AgUiCheckpoint,
  AgUiCustomState,
  AgUiRunMetadata,
  ConversationState,
  ConversationReplayToolTrace,
  StreamResult,
  StreamCompleteResult,
  StreamEvent,
} from "./session/streaming.ts";
export type {
  Streamer,
  MessageRenderer,
  ChatEventTransform,
  SessionOptions,
  ChatCommand,
} from "./session/options.ts";

export type {
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
} from "./state/index.ts";

export { groupTimelineByToolCall, initialChatState } from "./state/index.ts";
