import type { ToolCall } from "@sweatpants/model-provider";
import type { AgUiCheckpoint, AgUiCustomState } from "./streaming.ts";
import type { ServerToolResult } from "../core-types.ts";
import type { ElicitRequestStreamEvent } from "./streaming.ts";

export interface BuildAgUiCheckpointOptions {
  threadId: string;
  runId: string;
  parentRunId?: string;
  messages: AgUiCheckpoint["messages"]["messages"];
  assistantContent: string;
  toolCalls: ToolCall[];
  serverToolResults: ServerToolResult[];
}

export function buildAgUiCheckpoint(options: BuildAgUiCheckpointOptions): AgUiCheckpoint {
  const { threadId, runId, parentRunId, messages, assistantContent, toolCalls, serverToolResults } =
    options;

  return {
    run: {
      threadId,
      runId,
      ...(parentRunId ? { parentRunId } : {}),
    },
    messages: {
      messages,
    },
    state: {
      assistantContent,
      toolCalls: toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })),
      serverToolResults,
    },
  };
}

export function buildAgUiCustomState(options: {
  elicits?: ElicitRequestStreamEvent[];
}): AgUiCustomState {
  const pendingClientActions = (options.elicits ?? []).map((elicit) => ({
    toolCallId: elicit.callId,
    toolName: elicit.toolName,
    kind: "elicit" as const,
    sessionId: elicit.sessionId,
    elicitId: elicit.elicitId,
    key: elicit.key,
    message: elicit.message,
    ...(elicit.schema ? { schema: elicit.schema } : {}),
    ...(elicit.bindingId ? { bindingId: elicit.bindingId } : {}),
    ...(elicit.context !== undefined ? { context: elicit.context } : {}),
    ...(elicit.responseContract ? { responseContract: elicit.responseContract } : {}),
    ...(elicit.contextContract ? { contextContract: elicit.contextContract } : {}),
    ...(elicit.placement ? { placement: elicit.placement } : {}),
  }));

  return pendingClientActions.length > 0 ? { pendingClientActions } : {};
}
