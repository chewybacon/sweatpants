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
  ChatState,
  // Emission types (ctx.render pattern)
  ToolEmissionState,
  ToolEmissionTrackingState,
} from './chat-state'

export { initialChatState } from './chat-state'

// Reducer (framework-agnostic)
export { chatReducer } from './reducer'

// Message derivation (framework-agnostic)
export type { ComponentExtractor } from './derive-messages'
export {
  deriveMessages,
  deriveCompletedMessages,
  deriveStreamingMessage,
} from './derive-messages'
