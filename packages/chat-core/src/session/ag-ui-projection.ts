import type { Message } from "@sweatpants/chat-core";
import { internalMessagesToAgUiMessages, type AgUiMessage } from "./ag-ui-messages.ts";
import {
  activityMessageToPluginReplayTrace,
  buildPluginReplayActivity,
  type PluginReplayActivitySnapshotEvent,
} from "./plugin-replay.ts";
import type { ConversationReplayState } from "./streaming.ts";

function mergeReplayState(
  base: ConversationReplayState | undefined,
  messages: Message[],
): ConversationReplayState | undefined {
  const traces = new Map<string, ConversationReplayState["toolTraces"][number]>();

  for (const trace of base?.toolTraces ?? []) {
    traces.set(trace.callId, trace);
  }

  for (const message of messages) {
    const trace = activityMessageToPluginReplayTrace(message);
    if (trace) {
      traces.set(trace.callId, trace);
    }
  }

  return traces.size > 0 ? { toolTraces: [...traces.values()] } : undefined;
}

export function replayActivitySnapshots(
  replayState: ConversationReplayState | undefined,
): PluginReplayActivitySnapshotEvent[] {
  return (replayState?.toolTraces ?? []).flatMap((toolTrace) => {
    const activity = buildPluginReplayActivity({
      toolCallId: toolTrace.callId,
      toolName: toolTrace.toolName,
      trace: toolTrace.trace,
    });
    return activity ? [activity] : [];
  });
}

export function providerHistoryMessages(messages: Message[]): Message[] {
  return messages.filter((message) => message.role !== "activity");
}

export function toProviderHistorySnapshot(
  messages: Message[],
  _replayState: ConversationReplayState | undefined,
): AgUiMessage[] {
  return internalMessagesToAgUiMessages(providerHistoryMessages(messages));
}

export function activitySnapshotsForMessages(
  messages: Message[],
  replayState: ConversationReplayState | undefined,
): PluginReplayActivitySnapshotEvent[] {
  return replayActivitySnapshots(mergeReplayState(replayState, messages));
}
