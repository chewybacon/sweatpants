import type { Operation } from "effection";
import { call } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import { chatReducer, initialChatState } from "../state/reducer.ts";
import type {
  HydratedToolExecutionTrace,
  ToolExecutionTrace,
} from "../browser-rendering/emissions.ts";
import type { Message } from "../types.ts";
import type { ChatEventTransform, StreamEventEntry } from "./options.ts";
import type { ConversationReplayState, StreamEvent } from "./streaming.ts";
import { activitySnapshotToPluginReplayTrace } from "./plugin-replay.ts";

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
  const keys = new Map<string, number>();
  const result: Message[] = [];
  for (const message of messages) {
    const key = message.id
      ? `id:${message.id}`
      : message.role === "tool" && message.tool_call_id
        ? `tool:${message.tool_call_id}`
        : undefined;
    if (key && keys.has(key)) {
      result[keys.get(key)!] = message;
    } else {
      if (key) keys.set(key, result.length);
      result.push(message);
    }
  }
  return result;
}

export function* replayFramesToConversation(
  frames: DurableFrame[],
  tools?: unknown[],
  _transforms?: ChatEventTransform[],
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
  const response = yield* call(() =>
    fetch(url.pathname + url.search, {
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
