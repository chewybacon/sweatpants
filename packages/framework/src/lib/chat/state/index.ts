/**
 * lib/chat/state/index.ts
 *
 * State types for the chat system.
 */

// Timeline types
export type {
  TimelineUserMessage,
  TimelineAssistantText,
  TimelineThinking,
  TimelineToolCall,
  TimelineStep,
  TimelineItem,
  TimelineToolCallGroup,
  GroupedTimelineItem,
} from './timeline'

export { groupTimelineByToolCall } from './timeline'

// Chat state types
export type {
  ResponseStep,
  ActiveStep,
  RenderedContent,
  PendingClientToolState,
  PendingStepState,
  ExecutionTrailState,
  ChatState,
  // New emission types
  ToolEmissionState,
  ToolEmissionTrackingState,
} from './chat-state'

export { initialChatState } from './chat-state'
