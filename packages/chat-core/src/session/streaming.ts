import type { ToolCallInfo, ServerToolResult } from "../core-types.ts";
import type { ToolParameterValidationErrorPayload } from "@sweatpants/agent-sdk/tool";
import type { Message } from "../messages.ts";
import type { AgUiMessage } from "./ag-ui-messages.ts";
import type { PluginReplayActivitySnapshotEvent } from "./plugin-replay.ts";

export type { ConversationReplayToolTrace, ConversationReplayState } from "./replay-types.ts";
import type { ConversationReplayState } from "./replay-types.ts";
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
export interface AgUiRunErrorStreamEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}
export interface AgUiMessagesSnapshotStreamEvent {
  type: "MESSAGES_SNAPSHOT";
  messages: AgUiMessage[];
}
export interface AgUiStateSnapshotStreamEvent {
  type: "STATE_SNAPSHOT";
  snapshot: AgUiCustomState;
}
export interface AgUiTextMessageStartStreamEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role: "assistant" | "user" | "system" | "developer";
}
export interface AgUiTextMessageContentStreamEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface AgUiTextMessageEndStreamEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}
export interface AgUiToolCallStartStreamEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}
export interface AgUiToolCallArgsStreamEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}
export interface AgUiToolCallEndStreamEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}
export interface AgUiToolCallResultStreamEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  toolCallName?: string;
  content: string;
  role?: "tool";
  /**
   * Set by the producer that ran the tool. Consumers must never infer failure
   * from the content text: a successful tool may return output beginning with
   * "Error:".
   */
  isError?: boolean;
  error?: ToolParameterValidationErrorPayload;
}
export interface AgUiReasoningMessageContentStreamEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}

/** Internal runtime request shape. Public streams represent this as an AG-UI interrupt. */
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

/** Canonical AG-UI events accepted by the client fold and durable stream. */
export type StreamEvent =
  | AgUiRunStartedStreamEvent
  | AgUiRunFinishedStreamEvent
  | AgUiRunErrorStreamEvent
  | AgUiMessagesSnapshotStreamEvent
  | AgUiStateSnapshotStreamEvent
  | AgUiTextMessageStartStreamEvent
  | AgUiTextMessageContentStreamEvent
  | AgUiTextMessageEndStreamEvent
  | AgUiToolCallStartStreamEvent
  | AgUiToolCallArgsStreamEvent
  | AgUiToolCallEndStreamEvent
  | AgUiToolCallResultStreamEvent
  | PluginReplayActivitySnapshotEvent
  | AgUiReasoningMessageContentStreamEvent;
