import type { ChatState, ElicitTrackingState } from "./chat-state.ts";
import { initialChatState } from "./chat-state.ts";
import type { ChatStateEvent } from "./events.ts";
import type { Message } from "../types.ts";
import type { MessagePart, TextPart, ReasoningPart, ToolCallPart } from "../types/chat-message.ts";
import { getRenderedFromFrame } from "../types/chat-message.ts";
import { agUiMessagesToInternalMessages } from "../session/ag-ui-messages.ts";
import { activitySnapshotToPluginReplayTrace } from "../session/plugin-replay.ts";

export type { ChatStateEvent, LocalChatAction } from "./events.ts";
export { initialChatState };

function upsertMessage(messages: Message[], message: Message): Message[] {
  return messages.some((candidate) => candidate.id === message.id)
    ? messages.map((candidate) => (candidate.id === message.id ? message : candidate))
    : [...messages, message];
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function partsForMessages(messages: Message[]): Record<string, MessagePart[]> {
  const resultsByCallId = new Map(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => [message.tool_call_id!, message]),
  );
  const finalized: Record<string, MessagePart[]> = {};

  for (const message of messages) {
    if (!message.id || message.role !== "assistant") continue;
    const parts: MessagePart[] = [];
    if (message.content) {
      parts.push({
        id: `${message.id}:text`,
        type: "text",
        content: message.content,
        rendered: message.content,
      });
    }
    for (const call of message.tool_calls ?? []) {
      const result = resultsByCallId.get(call.id);
      const error = result?.content.startsWith("Error:") ? result.content : undefined;
      parts.push({
        id: `${message.id}:tool:${call.id}`,
        type: "tool-call",
        callId: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
        state: result ? (error ? "error" : "complete") : "running",
        ...(result && !error ? { result: result.content } : {}),
        ...(error ? { error } : {}),
        emissions: [],
        pluginElicits: [],
      });
    }
    if (parts.length > 0) finalized[message.id] = parts;
  }
  return finalized;
}

function appendContentPart(
  state: ChatState,
  kind: "text" | "reasoning",
  messageId: string,
  delta: string,
): ChatState {
  const active = state.streaming.parts.find(
    (part): part is TextPart | ReasoningPart =>
      part.id === state.streaming.activePartId &&
      (part.type === "text" || part.type === "reasoning"),
  );
  if (active?.type === kind) {
    return {
      ...state,
      streaming: {
        ...state.streaming,
        parts: state.streaming.parts.map((part) =>
          part.id === active.id
            ? {
                ...part,
                content: active.content + delta,
                rendered: active.frame ? active.rendered : active.content + delta,
              }
            : part,
        ),
      },
    };
  }

  const part: TextPart | ReasoningPart = {
    id: `${messageId}:${kind}`,
    type: kind,
    content: delta,
    rendered: delta,
  };
  return {
    ...state,
    streaming: {
      parts: [...state.streaming.parts, part],
      activePartId: part.id,
      activePartType: kind,
    },
  };
}

function pendingElicitsFromActions(
  actions: Array<{
    toolCallId: string;
    toolName: string;
    kind: "elicit";
    sessionId: string;
    elicitId: string;
    key: string;
    message: string;
    schema: Record<string, unknown>;
  }> = [],
): Record<string, ElicitTrackingState> {
  const pending: Record<string, ElicitTrackingState> = {};
  for (const action of actions) {
    const tracking = pending[action.toolCallId] ?? {
      callId: action.toolCallId,
      toolName: action.toolName,
      elicitations: [],
      status: "awaiting_elicit" as const,
      startedAt: Date.now(),
    };
    tracking.elicitations.push({
      elicitId: action.elicitId,
      sessionId: action.sessionId,
      callId: action.toolCallId,
      toolName: action.toolName,
      key: action.key,
      message: action.message,
      schema: action.schema,
      context: action.schema["x-elicit-context"],
      status: "pending",
      timestamp: Date.now(),
    });
    pending[action.toolCallId] = tracking;
  }
  return pending;
}

function addInterrupts(
  state: ChatState,
  interrupts: Array<{
    id: string;
    message?: string;
    toolCallId?: string;
    responseSchema?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>,
): ChatState {
  const pending = { ...state.pendingElicits };
  for (const interrupt of interrupts) {
    const callId = interrupt.toolCallId ?? interrupt.id;
    const metadata = interrupt.metadata ?? {};
    const toolName =
      typeof metadata["sweatpants/toolName"] === "string"
        ? metadata["sweatpants/toolName"]
        : (state.toolCallDrafts[callId]?.name ?? "unknown");
    const key =
      typeof metadata["sweatpants/key"] === "string" ? metadata["sweatpants/key"] : interrupt.id;
    const existing = pending[callId];
    if (existing?.elicitations.some((elicit) => elicit.elicitId === interrupt.id)) continue;
    pending[callId] = {
      callId,
      toolName,
      status: "awaiting_elicit",
      startedAt: existing?.startedAt ?? Date.now(),
      elicitations: [
        ...(existing?.elicitations ?? []),
        {
          elicitId: interrupt.id,
          sessionId: callId,
          callId,
          toolName,
          key,
          message: interrupt.message ?? "Input required",
          schema: interrupt.responseSchema ?? {},
          context: interrupt.responseSchema?.["x-elicit-context"],
          status: "pending",
          timestamp: Date.now(),
        },
      ],
    };
  }
  return { ...state, pendingElicits: pending };
}

/** Fold one canonical AG-UI event or explicit local-only action into ChatState. */
export function chatReducer(state: ChatState, event: ChatStateEvent): ChatState {
  switch (event.type) {
    case "RUN_STARTED":
      return {
        ...state,
        activeRun: { threadId: event.threadId, runId: event.runId },
        isStreaming: true,
        streaming: initialChatState.streaming,
        messageDrafts: {},
        toolCallDrafts: {},
        error: null,
      };

    case "MESSAGES_SNAPSHOT": {
      const messages = agUiMessagesToInternalMessages(event.messages).filter(
        (message) => message.role !== "activity",
      );
      const projectedParts = partsForMessages(messages);
      for (const message of messages) {
        if (!message.id) continue;
        const previous = state.messages.find((candidate) => candidate.id === message.id);
        const rendered = state.finalizedParts[message.id];
        if (previous?.content === message.content && rendered)
          projectedParts[message.id] = rendered;
      }
      return { ...state, messages, finalizedParts: projectedParts };
    }

    case "STATE_SNAPSHOT":
      return {
        ...state,
        pendingElicits: pendingElicitsFromActions(event.snapshot.pendingClientActions),
        ...(event.snapshot.replay ? { replay: event.snapshot.replay } : {}),
      };

    case "TEXT_MESSAGE_START":
      return {
        ...state,
        messageDrafts: {
          ...state.messageDrafts,
          [event.messageId]: { id: event.messageId, role: event.role, content: "" },
        },
      };

    case "TEXT_MESSAGE_CONTENT": {
      const draft = state.messageDrafts[event.messageId];
      if (!draft) return state;
      const next = {
        ...state,
        messageDrafts: {
          ...state.messageDrafts,
          [event.messageId]: { ...draft, content: draft.content + event.delta },
        },
      };
      return draft.role === "assistant"
        ? appendContentPart(next, "text", event.messageId, event.delta)
        : next;
    }

    case "REASONING_MESSAGE_CONTENT":
      return appendContentPart(state, "reasoning", event.messageId, event.delta);

    case "TEXT_MESSAGE_END": {
      const draft = state.messageDrafts[event.messageId];
      if (!draft) return state;
      const { [event.messageId]: _ended, ...messageDrafts } = state.messageDrafts;
      const message: Message = { id: draft.id, role: draft.role, content: draft.content };
      return {
        ...state,
        messages: upsertMessage(state.messages, message),
        finalizedParts:
          draft.role === "assistant" && state.streaming.parts.length > 0
            ? { ...state.finalizedParts, [draft.id]: [...state.streaming.parts] }
            : state.finalizedParts,
        streaming: draft.role === "assistant" ? initialChatState.streaming : state.streaming,
        messageDrafts,
      };
    }

    case "TOOL_CALL_START": {
      const parentMessageId = event.parentMessageId ?? `assistant:tools:${event.toolCallId}`;
      const draft = {
        id: event.toolCallId,
        name: event.toolCallName,
        arguments: "",
        parentMessageId,
      };
      const existing = state.messages.find((message) => message.id === parentMessageId);
      const host: Message = {
        id: parentMessageId,
        role: "assistant",
        content: existing?.content ?? "",
        tool_calls: [
          ...(existing?.tool_calls ?? []).filter((call) => call.id !== event.toolCallId),
          {
            id: event.toolCallId,
            type: "function",
            function: { name: event.toolCallName, arguments: {} },
          },
        ],
      };
      const toolPart: ToolCallPart = {
        id: `${parentMessageId}:tool:${event.toolCallId}`,
        type: "tool-call",
        callId: event.toolCallId,
        name: event.toolCallName,
        arguments: {},
        state: "running",
        emissions: [],
        pluginElicits: [],
      };
      return {
        ...state,
        messages: upsertMessage(state.messages, host),
        toolCallDrafts: { ...state.toolCallDrafts, [event.toolCallId]: draft },
        streaming: {
          parts: [...state.streaming.parts, toolPart],
          activePartId: toolPart.id,
          activePartType: "tool-call",
        },
      };
    }

    case "TOOL_CALL_ARGS": {
      const draft = state.toolCallDrafts[event.toolCallId];
      if (!draft) return state;
      const args = draft.arguments + event.delta;
      const nextDraft = { ...draft, arguments: args };
      const messages = state.messages.map((message): Message => {
        if (message.id !== draft.parentMessageId || !message.tool_calls) return message;
        return {
          ...message,
          tool_calls: message.tool_calls.map((call) =>
            call.id === event.toolCallId
              ? { ...call, function: { ...call.function, arguments: parseArguments(args) } }
              : call,
          ),
        };
      });
      const updatePart = (part: MessagePart): MessagePart =>
        part.type === "tool-call" && part.callId === event.toolCallId
          ? { ...part, arguments: parseArguments(args) }
          : part;
      return {
        ...state,
        messages,
        toolCallDrafts: { ...state.toolCallDrafts, [event.toolCallId]: nextDraft },
        streaming: { ...state.streaming, parts: state.streaming.parts.map(updatePart) },
        finalizedParts: Object.fromEntries(
          Object.entries(state.finalizedParts).map(([id, parts]) => [id, parts.map(updatePart)]),
        ),
      };
    }

    case "TOOL_CALL_END": {
      const draft = state.toolCallDrafts[event.toolCallId];
      if (!draft) return state;
      const host = state.messages.find((message) => message.id === draft.parentMessageId);
      const part = state.streaming.parts.find(
        (candidate) => candidate.type === "tool-call" && candidate.callId === event.toolCallId,
      );
      return {
        ...state,
        finalizedParts:
          host && part
            ? {
                ...state.finalizedParts,
                [draft.parentMessageId]: [
                  ...(state.finalizedParts[draft.parentMessageId] ?? []),
                  part,
                ],
              }
            : state.finalizedParts,
        streaming: initialChatState.streaming,
      };
    }

    case "TOOL_CALL_RESULT": {
      const toolName =
        event.toolCallName ?? state.toolCallDrafts[event.toolCallId]?.name ?? "unknown";
      const isError = event.error !== undefined || event.content.startsWith("Error:");
      const toolMessage: Message = {
        id: event.messageId,
        role: "tool",
        tool_call_id: event.toolCallId,
        content:
          isError && !event.content.startsWith("Error:")
            ? `Error: ${event.content}`
            : event.content,
        replay: { toolName },
      };
      const updatePart = (part: MessagePart): MessagePart =>
        part.type === "tool-call" && part.callId === event.toolCallId
          ? {
              ...part,
              state: isError ? "error" : "complete",
              ...(isError ? { error: toolMessage.content } : { result: event.content }),
            }
          : part;
      const { [event.toolCallId]: _completed, ...pendingElicits } = state.pendingElicits;
      return {
        ...state,
        messages: upsertMessage(state.messages, toolMessage),
        pendingElicits,
        streaming: { ...state.streaming, parts: state.streaming.parts.map(updatePart) },
        finalizedParts: Object.fromEntries(
          Object.entries(state.finalizedParts).map(([id, parts]) => [id, parts.map(updatePart)]),
        ),
      };
    }

    case "ACTIVITY_SNAPSHOT": {
      const trace = activitySnapshotToPluginReplayTrace(event);
      if (!trace) return state;
      const traces = new Map(
        (state.replay?.toolTraces ?? []).map((entry) => [entry.callId, entry]),
      );
      traces.set(trace.callId, trace);
      return { ...state, replay: { toolTraces: [...traces.values()] } };
    }

    case "RUN_FINISHED": {
      const next = {
        ...state,
        isStreaming: false,
        activeRun: null,
        streaming: initialChatState.streaming,
      };
      return event.outcome?.type === "interrupt"
        ? addInterrupts(next, event.outcome.interrupts)
        : next;
    }

    case "RUN_ERROR":
      return { ...state, error: event.message, isStreaming: false, activeRun: null };

    case "LOCAL_USER_MESSAGE":
    case "LOCAL_ASSISTANT_MESSAGE":
      return { ...state, messages: upsertMessage(state.messages, event.message), error: null };

    case "LOCAL_RENDER_FRAME":
    case "LOCAL_RENDER_END": {
      const rendered = getRenderedFromFrame(event.frame);
      const targetId =
        state.streaming.activePartType === event.partType
          ? state.streaming.activePartId
          : event.partId;
      if (!targetId) return state;
      return {
        ...state,
        streaming: {
          ...state.streaming,
          parts: state.streaming.parts.map((part) =>
            part.id === targetId
              ? { ...part, frame: event.frame, ...(rendered !== null ? { rendered } : {}) }
              : part,
          ),
          ...(event.type === "LOCAL_RENDER_END"
            ? { activePartId: null, activePartType: null }
            : {}),
        },
      };
    }

    case "LOCAL_ELICIT_RESPONSE": {
      const tracking = state.pendingElicits[event.callId];
      if (!tracking) return state;
      return {
        ...state,
        pendingElicits: {
          ...state.pendingElicits,
          [event.callId]: {
            ...tracking,
            elicitations: tracking.elicitations.map((elicit) =>
              elicit.elicitId === event.elicitId
                ? { ...elicit, status: "responded", response: event.response }
                : elicit,
            ),
          },
        },
      };
    }

    case "LOCAL_REPLAY_EMISSIONS":
      return {
        ...state,
        toolEmissions: { ...state.toolEmissions, [event.tracking.callId]: event.tracking },
      };

    case "LOCAL_ABORT":
      return {
        ...state,
        ...(event.message ? { messages: upsertMessage(state.messages, event.message) } : {}),
        isStreaming: false,
        activeRun: null,
        streaming: initialChatState.streaming,
      };

    case "LOCAL_ERROR":
      return { ...state, error: event.message, isStreaming: false };

    case "LOCAL_RESET":
      return initialChatState;
  }
}
