import type { Capabilities, ToolCallInfo, ServerToolResult } from '../core-types.ts'
import type { ToolExecutionTrace } from '../browser-rendering/emissions.ts'
import type { Message } from '../types.ts'

export interface ConversationReplayToolTrace {
  callId: string
  toolName: string
  trace: ToolExecutionTrace
}

export interface ConversationReplayState {
  toolTraces: ConversationReplayToolTrace[]
}

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
    kind: 'elicit'
    sessionId: string
    elicitId: string
    key: string
    message: string
    schema: Record<string, unknown>
  }>
}

export interface ConversationState {
  messages: Message[]
  assistantContent: string
  toolCalls: ToolCallInfo[]
  serverToolResults: ServerToolResult[]
  replay?: ConversationReplayState
}

export type StreamResult = StreamCompleteResult | StreamElicitResult

export interface StreamCompleteResult {
  type: 'complete'
  text: string
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>
  toolResults?: Array<{ id: string; name: string; content: string }>
  conversationState?: ConversationState
}

export interface StreamElicitResult {
  type: 'elicit'
  pendingElicitations: ElicitRequestStreamEvent[]
  conversationState: ConversationState
}

export interface ConversationStateStreamEvent {
  type: 'conversation_state'
  conversationState: ConversationState
}

export interface AgUiCheckpointStreamEvent {
  type: 'ag_ui_checkpoint'
  checkpoint: AgUiCheckpoint
}

export interface AgUiRunStartedStreamEvent {
  type: 'ag_ui_run_started'
  run: AgUiRunMetadata
  input?: { messages: Message[] }
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
  error?: import('../tool-parameters.ts').ToolParameterValidationErrorPayload
}

export interface ElicitRequestStreamEvent {
  type: 'elicit_request'
  sessionId: string
  callId: string
  toolName: string
  elicitId: string
  key: string
  message: string
  schema: Record<string, unknown>
}

export interface ToolSessionStatusStreamEvent {
  type: 'tool_session_status'
  sessionId: string
  callId: string
  toolName: string
  status: 'running' | 'awaiting_elicit' | 'completed' | 'failed' | 'aborted'
}

export interface ToolSessionErrorStreamEvent {
  type: 'tool_session_error'
  sessionId: string
  callId: string
  error: 'SESSION_NOT_FOUND' | 'SESSION_ABORTED' | 'INTERNAL_ERROR'
  message: string
}

export type StreamEvent =
  | { type: 'session_info'; capabilities: Capabilities; persona: string | null }
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
  | ElicitRequestStreamEvent
  | ToolSessionStatusStreamEvent
  | ToolSessionErrorStreamEvent
