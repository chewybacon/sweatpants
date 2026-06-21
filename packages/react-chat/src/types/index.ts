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
  IsomorphicToolState,
  Capabilities,
  BaseContentMetadata,
  ContentMetadata,
  RenderDelta,
  RevealHint,
  TokenUsage,
  ToolCallInfo,
  ServerToolResult,
} from '@sweatpants/framework/chat'

// Message types
export type { Message, ToolCall } from '@sweatpants/framework/chat'

// Chat message part types (parts-based model)
// Note: ChatEmission, ChatToolCall, ChatMessage, StreamingMessage are exported from useChat.ts
// with React-specific component types. We export the base types here with different names.
export type {
  TextPart,
  ReasoningPart,
  ToolCallPart,
  ToolResultPart,
  MessagePart,
  ContentPart,
} from '@sweatpants/framework/chat'

export {
  getRenderedFromFrame,
  isContentPart,
  getMessageTextContent,
  getMessageReasoningContent,
  getMessageToolCalls,
  createTextPart,
  createReasoningPart,
  createToolCallPart,
  createToolResultPart,
} from '@sweatpants/framework/chat'

// Patch types
export type {
  // Content part type
  ContentPartType,
  // Core patches
  SessionInfoPatch,
  UserMessagePatch,
  AssistantMessagePatch,
  StreamingStartPatch,
  StreamingTextPatch,
  StreamingReasoningPatch,
  StreamingEndPatch,
  PartFramePatch,
  PartEndPatch,
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
  // Emission patches (new ctx.render() pattern)
  ToolEmissionState,
  ToolEmissionTrackingState,
  ToolEmissionStartPatch,
  ToolEmissionPatch,
  ToolEmissionResponsePatch,
  ToolEmissionCompletePatch,
  EmissionPatch,
  // Elicitation patches (MCP plugin tools)
  ElicitState,
  ElicitTrackingState,
  ElicitStartPatch,
  ElicitPatch,
  ElicitResponsePatch,
  ElicitCompletePatch,
  ElicitPatchUnion,
  // Union
  ChatPatch,
} from '@sweatpants/framework/chat'

export {
  isCorePatch,
  isBufferPatch,
  isClientToolPatch,
  isIsomorphicToolPatch,
  isHandoffPatch,
  isEmissionPatch,
  isElicitPatch,
} from '@sweatpants/framework/chat'

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
  StreamingPartsState,
  PendingClientToolState,
  ChatState,
} from '@sweatpants/framework/chat'

export { groupTimelineByToolCall, initialChatState } from '@sweatpants/framework/chat'

// Session types
export type {
  ConversationState,
  StreamResult,
  StreamCompleteResult,
  StreamIsomorphicHandoffResult,
  ConversationStateStreamEvent,
  IsomorphicHandoffStreamEvent,
  StreamEvent,
  StreamEventEntry,
  Streamer,
  MessageRenderer,
  PatchTransform,
  SessionOptions,
  ChatCommand,
} from '@sweatpants/framework/chat'

// Isomorphic tool types
export type {
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
} from '@sweatpants/framework/chat'
