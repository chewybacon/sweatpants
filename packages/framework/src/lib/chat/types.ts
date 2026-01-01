/**
 * lib/chat/types.ts
 *
 * Core chat types - messages, provider events, and API types.
 * This file defines types specific to the chat protocol layer.
 *
 * For shared primitives, see: core-types.ts
 * For patches, see: patches/
 * For state, see: state/
 * For session config, see: session/
 */

// Re-export shared primitives from core-types
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
} from './core-types'

// Re-export from isomorphic-tools
export type {
  ServerToolContext,
  ServerAuthorityContext,
  IsomorphicHandoffEvent,
} from './isomorphic-tools/types'

// Re-export from session
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
} from './session'

// Re-export from state
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
} from './state'

export { groupTimelineByToolCall, initialChatState } from './state'

// Re-export from patches
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
} from './patches'

export {
  isCorePatch,
  isBufferPatch,
  isClientToolPatch,
  isIsomorphicToolPatch,
  isHandoffPatch,
  isExecutionTrailPatch,
} from './patches'

// =============================================================================
// MESSAGE TYPES (defined here - core to the chat protocol)
// =============================================================================

/**
 * Universal message interface that all chat providers must support.
 * This provides a common contract for message passing between layers.
 */
export interface Message {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  partial?: boolean
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  tool_call_id?: string
}

/**
 * Ollama-specific message format (alias for Message for backward compatibility).
 */
export type OllamaMessage = Message

/**
 * Tool call structure.
 * Note: The 'type' field is optional for backward compatibility with providers
 * that don't include it, but when sending to OpenAI/Anthropic APIs, the
 * 'type: function' field must be added.
 */
export interface ToolCall {
  id: string
  type?: 'function'
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

// =============================================================================
// PROVIDER EVENT TYPES
// =============================================================================

/**
 * Events emitted by chat providers during streaming.
 */
export type ChatEvent =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_calls'; toolCalls: ToolCall[] }

/**
 * Final result from a chat provider.
 */
export interface ChatResult {
  text: string
  thinking?: string
  toolCalls?: ToolCall[]
  usage: import('./core-types').TokenUsage
}

// =============================================================================
// CLIENT TOOL SCHEMA
// =============================================================================

/**
 * Schema for a client-side tool, sent to the server so it can be
 * included in the LLM request. The server doesn't execute these -
 * it passes them to the LLM and hands back to the client for execution.
 */
export interface ClientToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown> // JSON Schema
}

// =============================================================================
// OLLAMA REQUEST/RESPONSE TYPES
// =============================================================================

/**
 * Ollama chat request format.
 */
export interface OllamaChatRequest {
  model: string
  messages: Message[]
  stream?: boolean
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
}

/**
 * Ollama chat response chunk.
 */
export interface OllamaChatChunk {
  model: string
  created_at: string
  message: {
    role: string
    content: string
    thinking?: string // DeepSeek-R1 style
    tool_calls?: ToolCall[]
  }
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
  error?: string
}
