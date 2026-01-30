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
} from './timeline.ts'

export { groupTimelineByToolCall } from './timeline.ts'

// Chat state types
export type {
  PendingClientToolState,
  ChatState,
  StreamingPartsState,
  // Emission types (ctx.render pattern)
  ToolEmissionState,
  ToolEmissionTrackingState,
} from './chat-state.ts'

export { initialChatState } from './chat-state.ts'

// Reducer (framework-agnostic)
export { chatReducer } from './reducer.ts'

// Message derivation (framework-agnostic)
export type { ComponentExtractor } from './derive-messages.ts'
export {
  deriveMessages,
  deriveCompletedMessages,
  deriveStreamingMessage,
} from './derive-messages.ts'
