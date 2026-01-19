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
} from '../../../lib/chat/core-types.ts'

// Message types
export type { Message, ToolCall } from '../../../lib/chat/types.ts'

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
} from '../../../lib/chat/types/index.ts'

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
} from '../../../lib/chat/types/chat-message.ts'

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
  // Plugin elicitation patches (MCP plugin tools)
  PluginElicitState,
  PluginElicitTrackingState,
  PluginElicitStartPatch,
  PluginElicitPatch,
  PluginElicitResponsePatch,
  PluginElicitCompletePatch,
  PluginElicitPatchUnion,
  // Union
  ChatPatch,
} from '../../../lib/chat/patches/index.ts'

export {
  isCorePatch,
  isBufferPatch,
  isClientToolPatch,
  isIsomorphicToolPatch,
  isHandoffPatch,
  isEmissionPatch,
  isPluginElicitPatch,
} from '../../../lib/chat/patches/index.ts'

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
  // Legacy (deprecated)
  ResponseStep,
  ActiveStep,
  RenderedContent,
  // Note: ToolEmissionState and ToolEmissionTrackingState are exported from patches
} from '../../../lib/chat/state/index.ts'

export { groupTimelineByToolCall, initialChatState } from '../../../lib/chat/state/index.ts'

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
} from '../../../lib/chat/session/index.ts'

// Isomorphic tool types
export type {
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
} from '../../../lib/chat/isomorphic-tools/types.ts'
