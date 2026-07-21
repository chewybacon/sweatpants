import type { Operation } from "effection";
import { call } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type {
  HydratedToolExecutionTrace,
  ToolExecutionTrace,
} from "../browser-rendering/emissions.ts";
import type { Message } from "../types.ts";
import type { ChatEventTransform, ChatFetch, StreamEventEntry } from "./options.ts";
import type { ConversationReplayState, StreamEvent } from "./streaming.ts";
import { activitySnapshotToPluginReplayTrace } from "./plugin-replay.ts";
import { renderReplayMessageParts } from "./replay-render.ts";

export interface DurableFrame {
  lsn: number;
  event: StreamEvent;
}
type ReplayableTool = {
  name: string;
  replayTrace?: (trace: ToolExecutionTrace) => Operation<HydratedToolExecutionTrace>;
};
interface ReadDurableHistoryOptions {
  baseUrl: string;
  conversationId: string;
  tools?: unknown[];
  transforms?: ChatEventTransform[];
  onStreamEvent?: (entry: StreamEventEntry) => void;
  fetch?: ChatFetch;
}
export interface DurableHistoryReplay {
  events: ChatStateEvent[];
  history: Message[];
  replayState?: ConversationReplayState;
}

function replayableTool(value: unknown): value is ReplayableTool {
  return !!value && (typeof value === "object" || typeof value === "function") && "name" in value;
}

export function deduplicateMessages(messages: Message[]): Message[] {
  const positions = new Map<string, number>();
  const result: Message[] = [];
  for (const message of messages) {
    const key =
      message.role === "tool" && message.tool_call_id
        ? `tool:${message.tool_call_id}`
        : message.role === "assistant" && message.tool_calls?.length
          ? `assistant-tools:${message.tool_calls
              .map((call) => call.id)
              .sort()
              .join(",")}`
          : message.id
            ? `id:${message.id}`
            : undefined;
    const existingIndex = key ? positions.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) positions.set(key, result.length);
      result.push(message);
      continue;
    }
    const existing = result[existingIndex]!;
    if (message.role === "tool" && message.replay && !existing.replay) {
      result[existingIndex] = message;
    }
  }
  return result;
}

export function* replayFramesToConversation(
  frames: DurableFrame[],
  tools?: unknown[],
  transforms?: ChatEventTransform[],
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<DurableHistoryReplay> {
  const events: ChatStateEvent[] = [];
  let state = initialChatState;

  for (const frame of frames) {
    onStreamEvent?.({
      lsn: frame.lsn,
      event: frame.event,
      phase: "replay",
      receivedAt: Date.now(),
    });
    events.push(frame.event);
    state = chatReducer(state, frame.event);

    if (frame.event.type !== "ACTIVITY_SNAPSHOT") continue;
    const replay = activitySnapshotToPluginReplayTrace(frame.event);
    if (!replay) continue;
    const tool = tools?.find(
      (candidate): candidate is ReplayableTool =>
        replayableTool(candidate) && candidate.name === replay.toolName,
    );
    if (!tool?.replayTrace) continue;
    const hydrated = yield* tool.replayTrace(replay.trace);
    const tracking = {
      callId: replay.callId,
      toolName: replay.toolName,
      status: "complete" as const,
      startedAt: hydrated.startedAt,
      completedAt: hydrated.completedAt,
      emissions: hydrated.emissions
        .filter((entry) => entry._component)
        .map((entry) => ({
          id: entry.emissionId ?? `${replay.callId}-replay-${entry.order + 1}`,
          callId: replay.callId,
          toolName: replay.toolName,
          type: "__component__",
          payload: {
            componentKey: entry.componentKey,
            props: entry.props,
            ...(entry._component ? { _component: entry._component } : {}),
          },
          status: "complete" as const,
          timestamp: entry.timestamp,
          ...(entry.response !== undefined ? { response: entry.response } : {}),
        })),
    };
    const action: ChatStateEvent = { type: "LOCAL_REPLAY_EMISSIONS", tracking };
    events.push(action);
    state = chatReducer(state, action);
  }

  if (transforms?.length) {
    for (const message of state.messages) {
      if (message.role !== "assistant" || !message.content) continue;
      const rendered = yield* renderReplayMessageParts(message.id, message.content, transforms);
      if (!rendered) continue;
      const toolParts = (state.finalizedParts[message.id] ?? []).filter(
        (part) => part.type === "tool-call",
      );
      const action: ChatStateEvent = {
        type: "LOCAL_FINALIZED_PARTS",
        messageId: message.id,
        parts: [...rendered, ...toolParts],
      };
      events.push(action);
      state = chatReducer(state, action);
    }
  }

  return {
    events,
    history: deduplicateMessages(state.messages),
    ...(state.replay ? { replayState: state.replay } : {}),
  };
}

export function* readDurableHistory(
  options: ReadDurableHistoryOptions,
): Operation<DurableHistoryReplay> {
  const url = new URL(options.baseUrl, "http://localhost");
  url.searchParams.set("conversationId", options.conversationId);
  url.searchParams.set("offset", "0");
  const chatFetch = options.fetch ?? globalThis.fetch;
  const response = yield* call(() =>
    chatFetch(url.pathname + url.search, {
      method: "GET",
      headers: { Accept: "application/x-ndjson" },
    }),
  );
  if (response.status === 404) return { events: [], history: [] };
  if (!response.ok) throw new Error(`Failed to hydrate durable history: ${response.status}`);
  const text = (yield* call(() => response.text())).trim();
  if (!text) return { events: [], history: [] };
  const frames = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DurableFrame);
  return yield* replayFramesToConversation(
    frames,
    options.tools,
    options.transforms,
    options.onStreamEvent,
  );
}
