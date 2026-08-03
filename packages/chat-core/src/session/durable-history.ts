import { call, type Operation } from "effection";
import type { ChatStateEvent } from "../state/events.ts";
import { createChatStateProjection } from "./projection.ts";
import type { Message } from "../messages.ts";
import type { ChatEventTransform, ChatFetch, StreamEventEntry } from "./options.ts";
import type { StreamEvent } from "./streaming.ts";
import { renderReplayMessageParts } from "./replay-render.ts";

export interface DurableFrame {
  lsn: number;
  event: StreamEvent;
}
interface ReadDurableHistoryOptions {
  baseUrl: string;
  conversationId: string;
  transforms?: ChatEventTransform[];
  onStreamEvent?: (entry: StreamEventEntry) => void;
  fetch?: ChatFetch;
}
export interface DurableHistoryReplay {
  events: ChatStateEvent[];
  history: Message[];
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
              .map((toolCall) => toolCall.id)
              .sort()
              .join(",")}`
          : message.id
            ? `id:${message.id}`
            : undefined;
    const existingIndex = key ? positions.get(key) : undefined;
    if (existingIndex === undefined) {
      if (key) {
        positions.set(key, result.length);
      }
      result.push(message);
      continue;
    }
    void result[existingIndex];
  }
  return result;
}

export function* replayFramesToConversation(
  frames: DurableFrame[],
  transforms?: ChatEventTransform[],
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<DurableHistoryReplay> {
  const events: ChatStateEvent[] = [];
  const projection = createChatStateProjection();

  for (const frame of frames) {
    const receivedAt = Date.now();
    onStreamEvent?.({
      lsn: frame.lsn,
      event: frame.event,
      phase: "replay",
      receivedAt,
    });
    events.push(frame.event);
    projection.fold(frame.event, receivedAt);
  }

  let state = projection.state;
  if (transforms?.length) {
    for (const message of state.messages) {
      if (message.role !== "assistant" || !message.content) {
        continue;
      }
      const rendered = yield* renderReplayMessageParts(message.id, message.content, transforms);
      if (!rendered) {
        continue;
      }
      const toolParts = (state.finalizedParts[message.id] ?? []).filter(
        (part) => part.type === "tool-call",
      );
      const action: ChatStateEvent = {
        type: "LOCAL_FINALIZED_PARTS",
        messageId: message.id,
        parts: [...rendered, ...toolParts],
      };
      events.push(action);
      projection.fold(action, Date.now());
      state = projection.state;
    }
  }

  return {
    events,
    history: deduplicateMessages(state.messages),
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
  if (response.status === 404) {
    return { events: [], history: [] };
  }
  if (!response.ok) {
    throw new Error(`Failed to hydrate durable history: ${response.status}`);
  }
  const text = (yield* call(() => response.text())).trim();
  if (!text) {
    return { events: [], history: [] };
  }
  const frames = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DurableFrame);
  return yield* replayFramesToConversation(frames, options.transforms, options.onStreamEvent);
}
