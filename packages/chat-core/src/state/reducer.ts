import type { ChatStateInternal, ElicitTrackingState } from "./chat-state.ts";
import { createInitialChatStateInternal, initialChatStateInternal } from "./chat-state.ts";
import type { ChatStateEvent } from "./events.ts";
import type { Message } from "../messages.ts";
import type { MessagePart, TextPart, ReasoningPart, ToolCallPart } from "../types/chat-message.ts";
import { getRenderedFromFrame } from "../types/chat-message.ts";
import { agUiMessagesToInternalMessages } from "../session/ag-ui-messages.ts";
import { activitySnapshotToPluginReplayTrace } from "../session/plugin-replay.ts";
import type { Json } from "@sweatpants/foundation";

export type { ChatStateEvent, LocalChatAction } from "./events.ts";

function upsertMessage(messages: Message[], message: Message): Message[] {
  return messages.some((candidate) => candidate.id === message.id)
    ? messages.map((candidate) => (candidate.id === message.id ? message : candidate))
    : [...messages, message];
}

function upsertToolResult(messages: Message[], message: Message): Message[] {
  if (!message.tool_call_id) {
    return upsertMessage(messages, message);
  }
  const index = messages.findIndex(
    (candidate) => candidate.role === "tool" && candidate.tool_call_id === message.tool_call_id,
  );
  if (index < 0) {
    return [...messages, message];
  }
  return messages.map((candidate, candidateIndex) =>
    candidateIndex === index
      ? candidate.replay && !message.replay
        ? candidate
        : message
      : candidate,
  );
}

/**
 * Streaming argument deltas arrive as partial JSON text. Until the text is
 * complete it is not decodable, so the partial text itself is the honest value
 * to carry — an empty object would claim the model asked for nothing.
 */
function parseArguments(value: string): Json {
  try {
    return JSON.parse(value) as Json;
  } catch {
    return value;
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
    if (!message.id || message.role !== "assistant") {
      continue;
    }
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
      const error = result?.isError === true ? result.content : undefined;
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
    if (parts.length > 0) {
      finalized[message.id] = parts;
    }
  }
  return finalized;
}

function appendContentPart(
  state: ChatStateInternal,
  kind: "text" | "reasoning",
  messageId: string,
  delta: string,
): ChatStateInternal {
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
  actions:
    | Array<{
        toolCallId: string;
        toolName: string;
        kind: "elicit";
        sessionId: string;
        elicitId: string;
        key: string;
        message: string;
        schema: Record<string, unknown>;
      }>
    | undefined,
  current: Record<string, ElicitTrackingState>,
  observedAt: number,
): Record<string, ElicitTrackingState> {
  const pending: Record<string, ElicitTrackingState> = {};
  for (const action of actions ?? []) {
    const prior = current[action.toolCallId]?.elicitations.find(
      (elicit) => elicit.elicitId === action.elicitId,
    );
    const tracking = pending[action.toolCallId];
    const elicit = {
      elicitId: action.elicitId,
      sessionId: action.sessionId,
      callId: action.toolCallId,
      toolName: action.toolName,
      key: action.key,
      message: action.message,
      schema: action.schema,
      context: action.schema["x-elicit-context"],
      status: prior?.status ?? ("pending" as const),
      timestamp: prior?.timestamp ?? observedAt,
      ...(prior?.response !== undefined ? { response: prior.response } : {}),
    };
    pending[action.toolCallId] = tracking
      ? { ...tracking, elicitations: [...tracking.elicitations, elicit] }
      : {
          callId: action.toolCallId,
          toolName: action.toolName,
          elicitations: [elicit],
          status: "awaiting_elicit",
          startedAt: current[action.toolCallId]?.startedAt ?? observedAt,
        };
  }
  return pending;
}

function attachPendingElicits(
  part: MessagePart,
  pending: Record<string, ElicitTrackingState>,
): MessagePart {
  if (part.type !== "tool-call") {
    return part;
  }
  const tracking = pending[part.callId];
  if (!tracking) {
    return part;
  }
  return {
    ...part,
    pluginElicits: tracking.elicitations.map((elicit) => ({
      id: elicit.elicitId,
      key: elicit.key,
      message: elicit.message,
      context: elicit.context,
      status: elicit.status === "pending" ? "pending" : "responded",
      ...(elicit.response !== undefined ? { response: elicit.response } : {}),
      sessionId: elicit.sessionId,
      callId: elicit.callId,
      toolName: elicit.toolName,
    })),
  };
}

function addInterrupts(
  state: ChatStateInternal,
  interrupts: Array<{
    id: string;
    message?: string;
    toolCallId?: string;
    responseSchema?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>,
  observedAt: number,
): ChatStateInternal {
  const pending = { ...state.pendingElicits };
  for (const interrupt of interrupts) {
    const callId = interrupt.toolCallId ?? interrupt.id;
    const metadata = interrupt.metadata ?? {};
    const toolName =
      typeof metadata["sweatpants/toolName"] === "string"
        ? metadata["sweatpants/toolName"]
        : state.toolCallDrafts[callId]?.name;
    if (!toolName) {
      throw new Error(`Interrupt "${interrupt.id}" has no settled tool name`);
    }
    const key =
      typeof metadata["sweatpants/key"] === "string" ? metadata["sweatpants/key"] : interrupt.id;
    const existing = pending[callId];
    if (existing?.elicitations.some((elicit) => elicit.elicitId === interrupt.id)) {
      continue;
    }
    pending[callId] = {
      callId,
      toolName,
      status: "awaiting_elicit",
      startedAt: existing?.startedAt ?? observedAt,
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
          timestamp: observedAt,
        },
      ],
    };
  }
  return {
    ...state,
    pendingElicits: pending,
    streaming: {
      ...state.streaming,
      parts: state.streaming.parts.map((part) => attachPendingElicits(part, pending)),
    },
    finalizedParts: Object.fromEntries(
      Object.entries(state.finalizedParts).map(([id, parts]) => [
        id,
        parts.map((part) => attachPendingElicits(part, pending)),
      ]),
    ),
  };
}

/** Fold one canonical AG-UI event or explicit local-only action into ChatState. */
export function reduceChatState(
  state: ChatStateInternal,
  event: ChatStateEvent,
  observedAt: number,
): ChatStateInternal {
  const internalState = state;
  switch (event.type) {
    case "RUN_STARTED":
      return {
        ...state,
        activeRun: { threadId: event.threadId, runId: event.runId },
        isStreaming: true,
        streaming: initialChatStateInternal.streaming,
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
        if (!message.id) {
          continue;
        }
        const previous = state.messages.find((candidate) => candidate.id === message.id);
        const rendered = state.finalizedParts[message.id];
        if (previous?.content === message.content && rendered) {
          projectedParts[message.id] = rendered;
        }
      }
      return { ...state, messages, finalizedParts: projectedParts };
    }

    case "STATE_SNAPSHOT": {
      const pendingElicits = pendingElicitsFromActions(
        event.snapshot.pendingClientActions,
        state.pendingElicits,
        observedAt,
      );
      return {
        ...state,
        pendingElicits,
        streaming: {
          ...state.streaming,
          parts: state.streaming.parts.map((part) => attachPendingElicits(part, pendingElicits)),
        },
        finalizedParts: Object.fromEntries(
          Object.entries(state.finalizedParts).map(([id, parts]) => [
            id,
            parts.map((part) => attachPendingElicits(part, pendingElicits)),
          ]),
        ),
        ...(event.snapshot.replay ? { replay: event.snapshot.replay } : {}),
      };
    }

    case "TEXT_MESSAGE_START":
      return {
        ...state,
        messageDrafts: {
          ...internalState.messageDrafts,
          [event.messageId]: { id: event.messageId, role: event.role, content: "" },
        },
      };

    case "TEXT_MESSAGE_CONTENT": {
      const draft = internalState.messageDrafts[event.messageId] ?? {
        id: event.messageId,
        role: "assistant" as const,
        content: "",
      };
      const next = {
        ...state,
        messageDrafts: {
          ...internalState.messageDrafts,
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
      const draft = internalState.messageDrafts[event.messageId];
      if (!draft) {
        return state;
      }
      const { [event.messageId]: _ended, ...messageDrafts } = internalState.messageDrafts;
      const message: Message = { id: draft.id, role: draft.role, content: draft.content };
      return {
        ...state,
        messages: upsertMessage(state.messages, message),
        finalizedParts:
          draft.role === "assistant" && state.streaming.parts.length > 0
            ? { ...state.finalizedParts, [draft.id]: [...state.streaming.parts] }
            : state.finalizedParts,
        streaming:
          draft.role === "assistant" ? initialChatStateInternal.streaming : state.streaming,
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
        ended: false,
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
        toolCallDrafts: { ...internalState.toolCallDrafts, [event.toolCallId]: draft },
        streaming: {
          parts: [...state.streaming.parts, toolPart],
          activePartId: toolPart.id,
          activePartType: "tool-call",
        },
      };
    }

    case "TOOL_CALL_ARGS": {
      const draft = internalState.toolCallDrafts[event.toolCallId];
      if (!draft) {
        return state;
      }
      const args = draft.arguments + event.delta;
      const nextDraft = { ...draft, arguments: args };
      const updatePart = (part: MessagePart): MessagePart =>
        part.type === "tool-call" && part.callId === event.toolCallId
          ? { ...part, arguments: parseArguments(args) }
          : part;
      return {
        ...state,
        toolCallDrafts: { ...internalState.toolCallDrafts, [event.toolCallId]: nextDraft },
        streaming: { ...state.streaming, parts: state.streaming.parts.map(updatePart) },
        finalizedParts: Object.fromEntries(
          Object.entries(state.finalizedParts).map(([id, parts]) => [id, parts.map(updatePart)]),
        ),
      };
    }

    case "TOOL_CALL_END": {
      const draft = internalState.toolCallDrafts[event.toolCallId];
      if (!draft) {
        return state;
      }
      const toolCallDrafts = {
        ...internalState.toolCallDrafts,
        [event.toolCallId]: { ...draft, ended: true },
      };
      const siblings = Object.values(toolCallDrafts).filter(
        (candidate) => candidate.parentMessageId === draft.parentMessageId,
      );
      if (!siblings.every((candidate) => candidate.ended)) {
        return { ...state, toolCallDrafts };
      }

      const siblingIds = new Set(siblings.map((candidate) => candidate.id));
      const toolParts = state.streaming.parts.filter(
        (part): part is ToolCallPart => part.type === "tool-call" && siblingIds.has(part.callId),
      );
      const existing = state.messages.find((message) => message.id === draft.parentMessageId);
      const host: Message = {
        id: draft.parentMessageId,
        role: "assistant",
        content: existing?.content ?? "",
        tool_calls: siblings.map((candidate) => ({
          id: candidate.id,
          type: "function",
          function: { name: candidate.name, arguments: parseArguments(candidate.arguments) },
        })),
      };
      const remainingParts = state.streaming.parts.filter(
        (part) => part.type !== "tool-call" || !siblingIds.has(part.callId),
      );
      return {
        ...state,
        messages: upsertMessage(state.messages, host),
        toolCallDrafts,
        finalizedParts: {
          ...state.finalizedParts,
          [draft.parentMessageId]: [
            ...(state.finalizedParts[draft.parentMessageId] ?? []).filter(
              (part) => part.type !== "tool-call" || !siblingIds.has(part.callId),
            ),
            ...toolParts,
          ],
        },
        streaming: {
          parts: remainingParts,
          activePartId: null,
          activePartType: null,
        },
      };
    }

    case "TOOL_CALL_RESULT": {
      const toolName = event.toolCallName ?? internalState.toolCallDrafts[event.toolCallId]?.name;
      if (!toolName) {
        throw new Error(`Tool result "${event.toolCallId}" has no settled tool name`);
      }
      // The producer said whether this failed. Text is never a control signal.
      const isError = event.error !== undefined || event.isError === true;
      const toolMessage: Message = {
        id: event.messageId,
        role: "tool",
        tool_call_id: event.toolCallId,
        name: toolName,
        content: event.content,
        isError,
      };
      const updatePart = (part: MessagePart): MessagePart =>
        part.type === "tool-call" && part.callId === event.toolCallId
          ? {
              ...part,
              state: isError ? "error" : "complete",
              ...(isError ? { error: event.content } : { result: event.content }),
            }
          : part;
      const { [event.toolCallId]: _completed, ...pendingElicits } = state.pendingElicits;
      return {
        ...state,
        messages: upsertToolResult(state.messages, toolMessage),
        pendingElicits,
        streaming: { ...state.streaming, parts: state.streaming.parts.map(updatePart) },
        finalizedParts: Object.fromEntries(
          Object.entries(state.finalizedParts).map(([id, parts]) => [id, parts.map(updatePart)]),
        ),
      };
    }

    case "ACTIVITY_SNAPSHOT": {
      const trace = activitySnapshotToPluginReplayTrace(event);
      if (!trace) {
        return state;
      }
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
        streaming: initialChatStateInternal.streaming,
      };
      return event.outcome?.type === "interrupt"
        ? addInterrupts(next, event.outcome.interrupts, observedAt)
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
      if (!targetId) {
        return state;
      }
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
      if (!tracking) {
        return state;
      }
      const updatePart = (part: MessagePart): MessagePart =>
        part.type === "tool-call" && part.callId === event.callId
          ? {
              ...part,
              pluginElicits: part.pluginElicits.map((elicit) =>
                elicit.id === event.elicitId
                  ? { ...elicit, status: "responded", response: event.response }
                  : elicit,
              ),
            }
          : part;
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
        streaming: { ...state.streaming, parts: state.streaming.parts.map(updatePart) },
        finalizedParts: Object.fromEntries(
          Object.entries(state.finalizedParts).map(([id, parts]) => [id, parts.map(updatePart)]),
        ),
      };
    }

    case "LOCAL_REPLAY_EMISSIONS":
      return {
        ...state,
        toolEmissions: { ...state.toolEmissions, [event.tracking.callId]: event.tracking },
      };

    case "LOCAL_FINALIZED_PARTS":
      return {
        ...state,
        finalizedParts: { ...state.finalizedParts, [event.messageId]: event.parts },
      };

    case "LOCAL_ABORT":
      return {
        ...state,
        ...(event.message ? { messages: upsertMessage(state.messages, event.message) } : {}),
        isStreaming: false,
        activeRun: null,
        streaming: initialChatStateInternal.streaming,
      };

    case "LOCAL_ERROR":
      return { ...state, error: event.message, isStreaming: false };

    case "LOCAL_RESET":
      return createInitialChatStateInternal();
  }
}
