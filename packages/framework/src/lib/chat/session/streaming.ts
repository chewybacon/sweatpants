/**
 * lib/chat/session/streaming.ts
 *
 * Streaming types for chat sessions.
 */

import type { Capabilities, ToolCallInfo, ServerToolResult } from '../core-types.ts'
import type { IsomorphicHandoffEvent } from '../isomorphic-tools/types.ts'
import type { ToolExecutionTrace } from '../isomorphic-tools/runtime/emissions.ts'
import type { Message } from '../types.ts'

export interface ConversationReplayToolTrace {
  callId: string
  toolName: string
  trace: ToolExecutionTrace
}

export interface ConversationReplayState {
  toolTraces: ConversationReplayToolTrace[]
}

// =============================================================================
// AG-UI CHECKPOINT SHAPES
// =============================================================================

export interface AgUiRunMetadata {
  threadId: string
  runId: string
  parentRunId?: string
}

export interface AgUiMessagesSnapshot {
  messages: Message[]
}

export interface AgUiStateSnapshot {
  assistantContent: string
  toolCalls: ToolCallInfo[]
  serverToolResults: ServerToolResult[]
  replay?: ConversationReplayState
}

export interface AgUiCheckpoint {
  run: AgUiRunMetadata
  messages: AgUiMessagesSnapshot
  state: AgUiStateSnapshot
}

export interface AgUiCustomState {
  replay?: ConversationReplayState
  pendingClientActions?: Array<{
    toolCallId: string
    toolName: string
    kind: 'handoff' | 'elicit'
    params?: unknown
    sessionId?: string
    elicitId?: string
    key?: string
    message?: string
    schema?: Record<string, unknown>
    data?: unknown
    usesHandoff?: boolean
  }>
}

// =============================================================================
// CONVERSATION STATE
// =============================================================================

/**
 * Snapshot of conversation state when handing off to client for tool execution.
 */
export interface ConversationState {
  /** Full message history up to this point */
  messages: Message[]
  /** Text content the assistant generated before requesting tools */
  assistantContent: string
  /** Tool calls the assistant requested (both server and client) */
  toolCalls: ToolCallInfo[]
  /** Results from server-side tool execution (already complete) */
  serverToolResults: ServerToolResult[]
  /** Replay metadata needed to restore durable UI state across turns */
  replay?: ConversationReplayState
}

// =============================================================================
// STREAM RESULTS
// =============================================================================

/**
 * Result of a streaming chat request.
 */
export type StreamResult = StreamCompleteResult | StreamIsomorphicHandoffResult | StreamElicitResult

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
  /** Semantic conversation snapshot if server provided one */
  conversationState?: ConversationState
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

/**
 * Server has a tool awaiting elicitation from the client.
 * The stream is paused, waiting for client to send `elicitResponses`.
 */
export interface StreamElicitResult {
  type: 'elicit'
  /** Pending elicitation requests from tools */
  pendingElicitations: ElicitRequestStreamEvent[]
  /** Conversation state for re-initiation (includes assistant message with tool_calls) */
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
 * Transitional AG-UI-aligned checkpoint event.
 *
 * This intentionally coexists with `conversation_state` while we migrate durable
 * replay and refresh restore behavior onto an explicit checkpoint model.
 */
export interface AgUiCheckpointStreamEvent {
  type: 'ag_ui_checkpoint'
  checkpoint: AgUiCheckpoint
}

export interface AgUiRunStartedStreamEvent {
  type: 'ag_ui_run_started'
  run: AgUiRunMetadata
  input?: {
    messages: Message[]
  }
}

export interface AgUiRunFinishedStreamEvent {
  type: 'ag_ui_run_finished'
  run: AgUiRunMetadata
}

export interface AgUiMessagesSnapshotStreamEvent {
  type: 'ag_ui_messages_snapshot'
  run: AgUiRunMetadata
  messages: Message[]
}

export interface AgUiStateSnapshotStreamEvent {
  type: 'ag_ui_state_snapshot'
  run: AgUiRunMetadata
  state: AgUiCustomState
}

export interface AgUiTextMessageStartStreamEvent {
  type: 'ag_ui_text_message_start'
  messageId: string
  role: 'assistant' | 'user' | 'system'
}

export interface AgUiTextMessageContentStreamEvent {
  type: 'ag_ui_text_message_content'
  messageId: string
  delta: string
}

export interface AgUiTextMessageEndStreamEvent {
  type: 'ag_ui_text_message_end'
  messageId: string
}

export interface AgUiToolCallStartStreamEvent {
  type: 'ag_ui_tool_call_start'
  toolCallId: string
  toolCallName: string
  parentMessageId?: string
}

export interface AgUiToolCallArgsStreamEvent {
  type: 'ag_ui_tool_call_args'
  toolCallId: string
  delta: string
}

export interface AgUiToolCallEndStreamEvent {
  type: 'ag_ui_tool_call_end'
  toolCallId: string
}

export interface AgUiToolCallResultStreamEvent {
  type: 'ag_ui_tool_call_result'
  toolCallId: string
  toolCallName: string
  content: string
  trace?: ToolExecutionTrace
}

export interface AgUiToolCallErrorStreamEvent {
  type: 'ag_ui_tool_call_error'
  toolCallId: string
  toolCallName: string
  message: string
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
  /** Output from server execution */
  serverOutput: unknown
  /** True if this handoff uses the V7 two-phase pattern */
  usesHandoff?: boolean
}

/**
 * Event emitted when a tool needs elicitation from the client.
 */
export interface ElicitRequestStreamEvent {
  type: 'elicit_request'
  /** Session ID for the tool session */
  sessionId: string
  /** Tool call ID from the LLM */
  callId: string
  /** Name of the tool */
  toolName: string
  /** Unique ID for this elicitation request */
  elicitId: string
  /** Elicitation key (e.g., 'pickFlight', 'pickSeat') */
  key: string
  /** Human-readable message for the user */
  message: string
  /** JSON schema for the expected response, may contain x-model-context */
  schema: Record<string, unknown>
}

/**
 * Event emitted when a tool session status changes.
 */
export interface ToolSessionStatusStreamEvent {
  type: 'tool_session_status'
  sessionId: string
  callId: string
  toolName: string
  status: 'running' | 'awaiting_elicit' | 'completed' | 'failed' | 'aborted'
}

/**
 * Event emitted when a tool session has an error.
 */
export interface ToolSessionErrorStreamEvent {
  type: 'tool_session_error'
  sessionId: string
  callId: string
  error: 'SESSION_NOT_FOUND' | 'SESSION_ABORTED' | 'INTERNAL_ERROR'
  message: string
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
  | { type: 'thinking'; content: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | AgUiRunStartedStreamEvent
  | AgUiRunFinishedStreamEvent
  | AgUiMessagesSnapshotStreamEvent
  | AgUiStateSnapshotStreamEvent
  | AgUiTextMessageStartStreamEvent
  | AgUiTextMessageContentStreamEvent
  | AgUiTextMessageEndStreamEvent
  | AgUiToolCallStartStreamEvent
  | AgUiToolCallArgsStreamEvent
  | AgUiToolCallEndStreamEvent
  | AgUiToolCallResultStreamEvent
  | AgUiToolCallErrorStreamEvent
  | AgUiCheckpointStreamEvent
  | IsomorphicHandoffStreamEvent
  | ElicitRequestStreamEvent
  | ToolSessionStatusStreamEvent
  | ToolSessionErrorStreamEvent
