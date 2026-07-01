import type { Message } from "../types.ts";
import {
  internalMessageToAgUiMessage,
  internalMessagesToAgUiMessages,
  type AgUiMessage,
} from "./ag-ui-compat.ts";
import { buildPluginReplayActivity } from "./plugin-replay.ts";
import type { ConversationReplayState } from "./streaming.ts";

export function replayActivityMessages(
  replayState: ConversationReplayState | undefined,
): AgUiMessage[] {
  return (replayState?.toolTraces ?? []).flatMap((toolTrace) => {
    const activity = buildPluginReplayActivity({
      toolCallId: toolTrace.callId,
      toolName: toolTrace.toolName,
      trace: toolTrace.trace,
    });
    return activity
      ? [
          {
            id: activity.messageId,
            role: "activity" as const,
            activityType: activity.activityType,
            content: activity.content,
          },
        ]
      : [];
  });
}

export function messagesWithReplayActivities(
  messages: Message[],
  replayState: ConversationReplayState | undefined,
): AgUiMessage[] {
  const activitiesByCallId = new Map(
    replayActivityMessages(replayState).map((message) => [
      typeof message.content === "object" && message.content !== null
        ? String((message.content as { toolCallId?: unknown }).toolCallId ?? "")
        : "",
      message,
    ]),
  );
  activitiesByCallId.delete("");
  if (activitiesByCallId.size === 0) {
    return internalMessagesToAgUiMessages(messages);
  }

  const output: AgUiMessage[] = [];
  const inserted = new Set<string>();
  const toolResultCallIds = new Set(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id!),
  );

  for (const message of messages) {
    output.push(internalMessageToAgUiMessage(message));

    const toolCallId =
      message.role === "tool" && message.tool_call_id
        ? message.tool_call_id
        : message.role === "assistant" &&
            message.tool_calls?.length === 1 &&
            !toolResultCallIds.has(message.tool_calls[0]!.id)
          ? message.tool_calls[0]?.id
          : undefined;
    if (!toolCallId || inserted.has(toolCallId)) continue;

    const activity = activitiesByCallId.get(toolCallId);
    if (!activity) continue;
    output.push(activity);
    inserted.add(toolCallId);
  }

  for (const [toolCallId, activity] of activitiesByCallId) {
    if (!inserted.has(toolCallId)) output.push(activity);
  }

  return output;
}
