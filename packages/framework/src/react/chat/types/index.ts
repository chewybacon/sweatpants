/**
 * types/index.ts
 *
 * Internal re-exports for chat types.
 * These are implementation details - prefer specific imports.
 */

// Metadata types
export type {
  BaseContentMetadata,
  ContentMetadata,
} from './metadata'

// Processor types
export type {
  ProcessedOutput,
  ProcessorContext,
  ProcessorEmit,
  MessageRenderer,
} from './processor'

// Patch types
export type {
  BufferSettledPatch,
  BufferPendingPatch,
  BufferRawPatch,
  BufferRenderablePatch,
  RenderDelta,
  RevealHint,
  ClientToolAwaitingApprovalPatch,
  ClientToolExecutingPatch,
  ClientToolCompletePatch,
  ClientToolErrorPatch,
  ClientToolDeniedPatch,
  ClientToolProgressPatch,
  ClientToolPermissionRequestPatch,
  AuthorityMode,
  IsomorphicToolState,
  IsomorphicToolStatePatch,
  PendingHandoffState,
  PendingHandoffPatch,
  HandoffCompletePatch,
  ExecutionTrailStartPatch,
  ExecutionTrailStepPatch,
  ExecutionTrailCompletePatch,
  ExecutionTrailStepResponsePatch,
  Capabilities,
  ChatPatch,
} from './patch'

// State types
export type {
  ResponseStep,
  ActiveStep,
  RenderedContent,
  TimelineItem,
  TimelineUserMessage,
  TimelineAssistantText,
  TimelineThinking,
  TimelineToolCall,
  TimelineStep,
  PendingClientToolState,
  PendingStepState,
  ExecutionTrailState,
  ChatState,
} from './state'
export { initialChatState } from './state'

// Session types
export type {
  StreamResult,
  StreamCompleteResult,
  StreamIsomorphicHandoffResult,
  ApiMessage,
  ConversationState,
  ServerToolResult,
  ToolCallInfo,
  Streamer,
  SessionOptions,
  PatchTransform,
  TokenUsage,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  StreamEvent,
  ChatCommand,
} from './session'

// Re-export Message from lib
export type { Message } from '../../../lib/chat/types'

// Re-export groupTimelineByToolCall utility
export { groupTimelineByToolCall } from '../../../lib/chat/isomorphic-tools/runtime/types'
