/**
 * lib/chat/session/streaming.ts
 *
 * Streaming types for chat sessions.
 */

import type { Capabilities, TokenUsage, ToolCallInfo, ServerToolResult } from '../core-types'
import type { IsomorphicHandoffEvent } from '../isomorphic-tools/types'

// =============================================================================
// API MESSAGE
// =============================================================================

/**
 * Message format for API requests.
 */
export interface ApiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** Tool calls made by the assistant */
  tool_calls?: Array<{
    id: string
    function: {
      name: string
      arguments: Record<string, unknown>
    }
  }>
  /** For tool role: the ID of the tool call this is responding to */
  tool_call_id?: string
}

// =============================================================================
// CONVERSATION STATE
// =============================================================================

/**
 * Snapshot of conversation state when handing off to client for tool execution.
 */
export interface ConversationState {
  /** Full message history up to this point */
  messages: ApiMessage[]
  /** Text content the assistant generated before requesting tools */
  assistantContent: string
  /** Tool calls the assistant requested (both server and client) */
  toolCalls: ToolCallInfo[]
  /** Results from server-side tool execution (already complete) */
  serverToolResults: ServerToolResult[]
}

// =============================================================================
// STREAM RESULTS
// =============================================================================

/**
 * Result of a streaming chat request.
 */
export type StreamResult = StreamCompleteResult | StreamIsomorphicHandoffResult

/**
 * Normal completion - assistant finished responding.
 */
export interface StreamCompleteResult {
  type: 'complete'
  /** Final assistant text content */
  text: string
  /** Tool calls made during this turn (for history sync) */
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
  /** Tool results from this turn (for history sync) */
  toolResults?: Array<{ id: string; name: string; content: string }>
}

/**
 * Server has executed isomorphic tool server parts and is handing off
 * to client for client-side execution.
 */
export interface StreamIsomorphicHandoffResult {
  type: 'isomorphic_handoff'
  /** Handoff events from server (one per isomorphic tool call) */
  handoffs: IsomorphicHandoffEvent[]
  /** Conversation state for re-initiation */
  conversationState: ConversationState
}

// =============================================================================
// STREAM EVENTS
// =============================================================================

/**
 * Event emitted to provide full conversation state for client-side processing.
 */
export interface ConversationStateStreamEvent {
  type: 'conversation_state'
  conversationState: ConversationState
}

/**
 * Event emitted when an isomorphic tool's server part completes.
 */
export interface IsomorphicHandoffStreamEvent {
  type: 'isomorphic_handoff'
  /** Unique ID of this tool call */
  callId: string
  /** Name of the isomorphic tool */
  toolName: string
  /** Original params from LLM */
  params: unknown
  /** Output from server execution (undefined for client-authority) */
  serverOutput: unknown
  /** Authority mode determines data flow */
  authority: 'server' | 'client'
  /** True if this handoff uses the V7 two-phase pattern */
  usesHandoff?: boolean
}

/**
 * All stream event types.
 */
export type StreamEvent =
  | {
      type: 'session_info'
      capabilities: Capabilities
      persona: string | null
    }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'tool_calls'
      calls: Array<{ id: string; name: string; arguments: unknown }>
    }
  | { type: 'tool_result'; id: string; name: string; content: string }
  | { type: 'tool_error'; id: string; name: string; message: string }
  | { type: 'complete'; text: string; usage?: TokenUsage }
  | { type: 'error'; message: string; recoverable: boolean }
  | IsomorphicHandoffStreamEvent
  | ConversationStateStreamEvent
