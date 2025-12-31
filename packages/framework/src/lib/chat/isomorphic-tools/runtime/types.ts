/**
 * lib/chat/isomorphic-tools/runtime/types.ts
 *
 * Runtime types for the isomorphic tools executor.
 * 
 * IMPORTANT: This file now re-exports types from the canonical sources.
 * Do NOT add new type definitions here - add them to the appropriate module:
 * - Core primitives: lib/chat/core-types.ts
 * - Patches: lib/chat/patches/
 * - State: lib/chat/state/
 * - Session: lib/chat/session/
 */

// =============================================================================
// RE-EXPORTS FROM CANONICAL SOURCES
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
} from '../../core-types'

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
  // Union
  ChatPatch,
} from '../../patches'

export {
  isCorePatch,
  isBufferPatch,
  isClientToolPatch,
  isIsomorphicToolPatch,
  isHandoffPatch,
  isExecutionTrailPatch,
} from '../../patches'

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
  ChatState,
  ToolEmissionState,
  ToolEmissionTrackingState,
} from '../../state'

export { groupTimelineByToolCall, initialChatState } from '../../state'

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
} from '../../session'

// Message types from lib/chat/types
export type { Message, ToolCall } from '../../types'

// Isomorphic tool types
export type {
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
} from '../types'

// =============================================================================
// EXECUTOR-SPECIFIC TYPES (defined here only)
// =============================================================================

/**
 * Chat message alias (for compatibility).
 */
export type ChatMessage = import('../../types').Message
