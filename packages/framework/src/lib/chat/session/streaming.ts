import type { Capabilities, ToolCallInfo, ServerToolResult } from "../core-types.ts";
import type { ToolExecutionTrace } from "../browser-rendering/emissions.ts";
import type { Message } from "../types.ts";
import type { AgUiMessage } from "./ag-ui-compat.ts";
import type { PluginReplayActivitySnapshotEvent } from "./plugin-replay.ts";

export interface ConversationReplayToolTrace {
  callId: string;
  toolName: string;
  trace: ToolExecutionTrace;
}

export interface ConversationReplayState {
  toolTraces: ConversationReplayToolTrace[];
}

/**
 * AG-UI run correlation metadata (wire projection only).
 *
 * Identity law:
 * - threadId MUST equal the durable conversationId
 * - runId is request/turn scoped and MUST NOT key durable fold state
 * - X-Session-Id / stream buffer ids are transport-only and MUST NOT appear here
 */
export interface AgUiRunMetadata {
  threadId: string;
  runId: string;
  parentRunId?: string;
}

export interface AgUiMessagesSnapshot {
  messages: Message[];
}

export interface AgUiStateSnapshot {
  assistantContent: string;
  toolCalls: ToolCallInfo[];
  serverToolResults: ServerToolResult[];
  replay?: ConversationReplayState;
}

export interface AgUiCheckpoint {
  run: AgUiRunMetadata;
  messages: AgUiMessagesSnapshot;
  state: AgUiStateSnapshot;
}

export interface AgUiCustomState {
  replay?: ConversationReplayState;
  pendingClientActions?: Array<{
    toolCallId: string;
    toolName: string;
    kind: "elicit";
    sessionId: string;
    elicitId: string;
    key: string;
    message: string;
    schema: Record<string, unknown>;
  }>;
}

export interface ConversationState {
  messages: Message[];
  assistantContent: string;
  toolCalls: ToolCallInfo[];
  serverToolResults: ServerToolResult[];
  replay?: ConversationReplayState;
}

export type StreamResult = StreamCompleteResult | StreamElicitResult;

export interface StreamCompleteResult {
  type: "complete";
  text: string;
  toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
  toolResults?: Array<{ id: string; name: string; content: string }>;
  conversationState?: ConversationState;
  /** Server-minted conversation identity, when returned by the chat endpoint. */
  conversationId?: string;
}

export interface StreamElicitResult {
  type: "elicit";
  pendingElicitations: ElicitRequestStreamEvent[];
  conversationState: ConversationState;
  /** Server-minted conversation identity, when returned by the chat endpoint. */
  conversationId?: string;
}

export interface ConversationStateStreamEvent {
  type: "conversation_state";
  conversationState: ConversationState;
}

export interface AgUiCheckpointStreamEvent {
  type: "ag_ui_checkpoint";
  checkpoint: AgUiCheckpoint;
}

export interface AgUiRunStartedStreamEvent {
  type: "RUN_STARTED";
  threadId: string;
  runId: string;
  parentRunId?: string;
  input?: {
    threadId: string;
    runId: string;
    parentRunId?: string;
    state: unknown;
    messages: AgUiMessage[];
    tools: Array<{ name: string; description: string; parameters: unknown }>;
    context: Array<{ description: string; value: string }>;
    forwardedProps: unknown;
    resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>;
  };
}

export interface LegacyAgUiRunStartedStreamEvent {
  type: "ag_ui_run_started";
  run: AgUiRunMetadata;
  input?: { messages: Message[] };
}

export interface AgUiRunFinishedStreamEvent {
  type: "RUN_FINISHED";
  threadId: string;
  runId: string;
  result?: unknown;
  outcome?:
    | { type: "success" }
    | {
        type: "interrupt";
        interrupts: Array<{
          id: string;
          reason: string;
          message?: string;
          toolCallId?: string;
          responseSchema?: Record<string, unknown>;
          expiresAt?: string;
          metadata?: Record<string, unknown>;
        }>;
      };
}

export interface LegacyAgUiRunFinishedStreamEvent {
  type: "ag_ui_run_finished";
  run: AgUiRunMetadata;
}

export interface AgUiRunErrorStreamEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}

export interface AgUiMessagesSnapshotStreamEvent {
  type: "MESSAGES_SNAPSHOT";
  messages: AgUiMessage[];
}

export interface LegacyAgUiMessagesSnapshotStreamEvent {
  type: "ag_ui_messages_snapshot";
  run: AgUiRunMetadata;
  messages: Message[];
}

export interface AgUiStateSnapshotStreamEvent {
  type: "STATE_SNAPSHOT";
  snapshot: AgUiCustomState;
}

export interface LegacyAgUiStateSnapshotStreamEvent {
  type: "ag_ui_state_snapshot";
  run: AgUiRunMetadata;
  state: AgUiCustomState;
}

export interface AgUiTextMessageStartStreamEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: "assistant" | "user" | "system" | "developer";
}

export interface LegacyAgUiTextMessageStartStreamEvent {
  type: "ag_ui_text_message_start";
  messageId: string;
  role: "assistant" | "user" | "system";
}

export interface AgUiTextMessageContentStreamEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface LegacyAgUiTextMessageContentStreamEvent {
  type: "ag_ui_text_message_content";
  messageId: string;
  delta: string;
}

export interface AgUiTextMessageEndStreamEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}

export interface LegacyAgUiTextMessageEndStreamEvent {
  type: "ag_ui_text_message_end";
  messageId: string;
}

export interface AgUiToolCallStartStreamEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface LegacyAgUiToolCallStartStreamEvent {
  type: "ag_ui_tool_call_start";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export interface AgUiToolCallArgsStreamEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}

export interface LegacyAgUiToolCallArgsStreamEvent {
  type: "ag_ui_tool_call_args";
  toolCallId: string;
  delta: string;
}

export interface AgUiToolCallEndStreamEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}

export interface LegacyAgUiToolCallEndStreamEvent {
  type: "ag_ui_tool_call_end";
  toolCallId: string;
}

export interface AgUiToolCallResultStreamEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  toolCallName?: string;
  content: string;
  role?: "tool";
  error?: import("../tool-parameters.ts").ToolParameterValidationErrorPayload;
}

export interface LegacyAgUiToolCallResultStreamEvent {
  type: "ag_ui_tool_call_result";
  toolCallId: string;
  toolCallName: string;
  content: string;
  trace?: ToolExecutionTrace;
}

export interface LegacyAgUiToolCallErrorStreamEvent {
  type: "ag_ui_tool_call_error";
  toolCallId: string;
  toolCallName: string;
  message: string;
  error?: import("../tool-parameters.ts").ToolParameterValidationErrorPayload;
}

export interface AgUiReasoningMessageContentStreamEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

export interface ElicitRequestStreamEvent {
  type: "elicit_request";
  sessionId: string;
  callId: string;
  toolName: string;
  elicitId: string;
  key: string;
  message: string;
  schema: Record<string, unknown>;
}

export interface ToolSessionStatusStreamEvent {
  type: "tool_session_status";
  sessionId: string;
  callId: string;
  toolName: string;
  status: "running" | "awaiting_elicit" | "completed" | "failed" | "aborted";
}

export interface ToolSessionErrorStreamEvent {
  type: "tool_session_error";
  sessionId: string;
  callId: string;
  error: "SESSION_NOT_FOUND" | "SESSION_ABORTED" | "INTERNAL_ERROR";
  message: string;
}

export type StreamEvent =
  | { type: "session_info"; capabilities: Capabilities; persona: string | null }
  | { type: "thinking"; content: string }
  | { type: "error"; message: string; recoverable: boolean }
  | AgUiRunStartedStreamEvent
  | LegacyAgUiRunStartedStreamEvent
  | AgUiRunFinishedStreamEvent
  | LegacyAgUiRunFinishedStreamEvent
  | AgUiRunErrorStreamEvent
  | AgUiMessagesSnapshotStreamEvent
  | LegacyAgUiMessagesSnapshotStreamEvent
  | AgUiStateSnapshotStreamEvent
  | LegacyAgUiStateSnapshotStreamEvent
  | AgUiTextMessageStartStreamEvent
  | LegacyAgUiTextMessageStartStreamEvent
  | AgUiTextMessageContentStreamEvent
  | LegacyAgUiTextMessageContentStreamEvent
  | AgUiTextMessageEndStreamEvent
  | LegacyAgUiTextMessageEndStreamEvent
  | AgUiToolCallStartStreamEvent
  | LegacyAgUiToolCallStartStreamEvent
  | AgUiToolCallArgsStreamEvent
  | LegacyAgUiToolCallArgsStreamEvent
  | AgUiToolCallEndStreamEvent
  | LegacyAgUiToolCallEndStreamEvent
  | AgUiToolCallResultStreamEvent
  | LegacyAgUiToolCallResultStreamEvent
  | LegacyAgUiToolCallErrorStreamEvent
  | AgUiCheckpointStreamEvent
  | PluginReplayActivitySnapshotEvent
  | AgUiReasoningMessageContentStreamEvent
  | ElicitRequestStreamEvent
  | ToolSessionStatusStreamEvent
  | ToolSessionErrorStreamEvent;
