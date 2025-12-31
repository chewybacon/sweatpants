/**
 * react/chat/types/index.ts
 *
 * Type exports for the React chat system.
 * 
 * All types are now defined in lib/chat and re-exported here for convenience.
 * This keeps the React layer as a consumer of shared types, not a definer.
 */

// =============================================================================
// RE-EXPORTS FROM lib/chat
// =============================================================================

// Core types
export type {
  AuthorityMode,
  IsomorphicToolState,
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
  ToolCallInfo,
  ServerToolResult,
} from '../../../lib/chat/core-types'

// Message types
export type { Message, ToolCall } from '../../../lib/chat/types'

// Patch types
export type {
  // Core patches
  SessionInfoPatch,
  UserMessagePatch,
  AssistantMessagePatch,
  StreamingStartPatch,
  StreamingTextPatch,
  StreamingThinkingPatch,
  StreamingEndPatch,
  ToolCallStartPatch,
  ToolCallResultPatch,
  ToolCallErrorPatch,
  AbortCompletePatch,
  ErrorPatch,
  ResetPatch,
  CorePatch,
  // Buffer patches
  BufferSettledPatch,
  BufferPendingPatch,
  BufferRawPatch,
  BufferRenderablePatch,
  BufferPatch,
  // Client tool patches
  ClientToolAwaitingApprovalPatch,
  ClientToolExecutingPatch,
  ClientToolCompletePatch,
  ClientToolErrorPatch,
  ClientToolDeniedPatch,
  ClientToolProgressPatch,
  ClientToolPermissionRequestPatch,
  ClientToolPatch,
  // Isomorphic tool patches
  IsomorphicToolStatePatch,
  IsomorphicToolPatch,
  // Handoff patches
  PendingHandoffState,
  PendingHandoffPatch,
  HandoffCompletePatch,
  HandoffPatch,
  // Execution trail patches
  ExecutionTrailStepData,
  ExecutionTrailStartPatch,
  ExecutionTrailStepPatch,
  ExecutionTrailCompletePatch,
  ExecutionTrailStepResponsePatch,
  ExecutionTrailPatch,
  // Emission patches (new ctx.render() pattern)
  ToolEmissionState,
  ToolEmissionTrackingState,
  ToolEmissionStartPatch,
  ToolEmissionPatch,
  ToolEmissionResponsePatch,
  ToolEmissionCompletePatch,
  EmissionPatch,
  // Union
  ChatPatch,
} from '../../../lib/chat/patches'

export {
  isCorePatch,
  isBufferPatch,
  isClientToolPatch,
  isIsomorphicToolPatch,
  isHandoffPatch,
  isExecutionTrailPatch,
  isEmissionPatch,
} from '../../../lib/chat/patches'

// State types
export type {
  TimelineUserMessage,
  TimelineAssistantText,
  TimelineThinking,
  TimelineToolCall,
  TimelineStep,
  TimelineItem,
  TimelineToolCallGroup,
  GroupedTimelineItem,
  ResponseStep,
  ActiveStep,
  RenderedContent,
  PendingClientToolState,
  PendingStepState,
  ExecutionTrailState,
  ToolEmissionState as ToolEmissionStateFromState,
  ToolEmissionTrackingState as ToolEmissionTrackingStateFromState,
  ChatState,
} from '../../../lib/chat/state'

export { groupTimelineByToolCall, initialChatState } from '../../../lib/chat/state'

// Session types
export type {
  ApiMessage,
  ConversationState,
  StreamResult,
  StreamCompleteResult,
  StreamIsomorphicHandoffResult,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  StreamEvent,
  Streamer,
  MessageRenderer,
  PatchTransform,
  SessionOptions,
  ChatCommand,
} from '../../../lib/chat/session'

// Isomorphic tool types
export type {
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
} from '../../../lib/chat/isomorphic-tools/types'
