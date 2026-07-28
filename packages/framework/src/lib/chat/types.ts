/**
 * lib/chat/types.ts
 *
 * Re-export barrel for chat types. This file aggregates types from
 * their canonical owners (messages.ts, core-types.ts, session/, state/)
 * so that existing consumers can import from a single location during
 * the framework dissolution.
 *
 * No types are defined here — this is a pure re-export hub. The cycle
 * with session/state modules is broken because those modules import
 * Message from messages.ts, not from this barrel.
 */

// Re-export shared primitives from core-types
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

// Re-export message types from canonical owner
export type {
  Message,
  ToolCall,
  ChatEvent,
  ChatResult,
  ClientToolSchema,
  OllamaChatRequest,
  OllamaChatChunk,
} from "./messages.ts";

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
