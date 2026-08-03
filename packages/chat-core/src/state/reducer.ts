import { EventType } from "@ag-ui/core";
import {
  createInitialChatStateInternal,
  type ChatStateInternal,
  type ElicitTrackingState,
} from "./chat-state.ts";

const initialStreaming = createInitialChatStateInternal().streaming;
import type { ChatStateEvent } from "./events.ts";
import type { Message } from "../messages.ts";
import {
  getRenderedFromFrame,
  type MessagePart,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
} from "../types/chat-message.ts";
import { decodePublicActivity } from "../chat-client-codec.ts";
import { agUiMessagesToInternalMessages } from "../session/ag-ui-messages.ts";
import type { Json } from "@sweatpants/foundation";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import type { TreePlacement } from "../recursive-tree.ts";

export type { ChatStateEvent, LocalChatAction } from "./events.ts";

function interruptFacts(metadata: unknown): Record<string, unknown> | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const facts = (metadata as Record<string, unknown>)["sweatpants/elicitation"];
  return facts !== null && typeof facts === "object" && !Array.isArray(facts)
    ? (facts as Record<string, unknown>)
    : undefined;
}

function descriptorFact(value: unknown): PortableSchemaDescriptor | undefined {
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    return undefined;
  }
}

function placementFact(value: unknown): TreePlacement | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const placement = value as Record<string, unknown>;
  return typeof placement["nodeId"] === "string" &&
    (placement["parentNodeId"] === null || typeof placement["parentNodeId"] === "string") &&
    typeof placement["sequence"] === "number" &&
    Number.isSafeInteger(placement["sequence"]) &&
    placement["sequence"] >= 0
    ? {
        nodeId: placement["nodeId"],
        parentNodeId: placement["parentNodeId"],
        sequence: placement["sequence"],
      }
    : undefined;
}

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
    candidateIndex === index ? message : candidate,
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
        schema?: Record<string, unknown>;
        bindingId?: string;
        context?: Json;
        responseContract?: PortableSchemaDescriptor;
        contextContract?: PortableSchemaDescriptor;
        placement?: TreePlacement;
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
      ...(action.schema ? { schema: action.schema } : {}),
      ...(action.bindingId ? { bindingId: action.bindingId } : {}),
      ...(action.responseContract ? { responseContract: action.responseContract } : {}),
      ...(action.contextContract ? { contextContract: action.contextContract } : {}),
      ...(action.placement ? { placement: action.placement, seq: action.placement.sequence } : {}),
      ...(action.context !== undefined ? { context: action.context } : {}),
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

function addInterrupts(
  state: ChatStateInternal,
  interrupts: Array<{
    id: string;
    message?: string;
    toolCallId?: string;
    responseSchema?: Record<string, unknown>;
    bindingId?: string;
    context?: Json;
    responseContract?: PortableSchemaDescriptor;
    contextContract?: PortableSchemaDescriptor;
    placement?: TreePlacement;
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
          ...(interrupt.bindingId ? { bindingId: interrupt.bindingId } : {}),
          ...(interrupt.responseContract ? { responseContract: interrupt.responseContract } : {}),
          ...(interrupt.contextContract ? { contextContract: interrupt.contextContract } : {}),
          ...(interrupt.placement
            ? { placement: interrupt.placement, seq: interrupt.placement.sequence }
            : {}),
          ...(interrupt.context !== undefined ? { context: interrupt.context } : {}),
          status: "pending",
          timestamp: observedAt,
        },
      ],
    };
  }
  return { ...state, pendingElicits: pending };
}

/** Fold one canonical AG-UI event or explicit local-only action into ChatState. */
export function reduceChatState(
  state: ChatStateInternal,
  event: ChatStateEvent,
  observedAt: number,
): ChatStateInternal {
  const internalState = state;
  switch (event.type) {
    case EventType.RUN_STARTED:
      return {
        ...state,
        activeRun: { threadId: event.threadId, runId: event.runId },
        active: true,
        streaming: initialStreaming,
        messageDrafts: {},
        toolCallDrafts: {},
        error: null,
      };

    case EventType.MESSAGES_SNAPSHOT: {
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

    case EventType.ACTIVITY_SNAPSHOT: {
      if (event.activityType !== "sweatpants:public-execution") {
        return state;
      }
      const activity = decodePublicActivity(event.content);
      const data = activity.node.publicData;
      if (data?.kind !== "elicit") {
        return state;
      }
      const current = state.pendingElicits[data.callId];
      const elicit = {
        elicitId: data.elicitId,
        sessionId: data.elicitId,
        callId: data.callId,
        toolName: data.toolName,
        key: data.key,
        message: data.message,
        bindingId: data.bindingId,
        responseContract: data.responseContract,
        ...(data.contextContract !== undefined ? { contextContract: data.contextContract } : {}),
        ...(data.context !== undefined ? { context: data.context } : {}),
        placement: {
          nodeId: activity.node.nodeId,
          parentNodeId: activity.node.parentNodeId,
          sequence: activity.node.sequence,
        },
        seq: data.producerSequence,
        status:
          activity.node.state === "responded"
            ? ("responded" as const)
            : activity.node.state === "cancelled"
              ? ("cancelled" as const)
              : ("pending" as const),
        timestamp: observedAt,
      };
      return {
        ...state,
        pendingElicits: {
          ...state.pendingElicits,
          [data.callId]: {
            callId: data.callId,
            toolName: data.toolName,
            elicitations: [
              ...(current?.elicitations.filter((item) => item.elicitId !== data.elicitId) ?? []),
              elicit,
            ],
            status: "awaiting_elicit",
            startedAt: current?.startedAt ?? observedAt,
          },
        },
      };
    }

    case EventType.STATE_SNAPSHOT: {
      const pendingElicits = pendingElicitsFromActions(
        event.snapshot.pendingClientActions,
        state.pendingElicits,
        observedAt,
      );
      return { ...state, pendingElicits };
    }

    case EventType.TEXT_MESSAGE_START:
      return {
        ...state,
        messageDrafts: {
          ...internalState.messageDrafts,
          [event.messageId]: { id: event.messageId, role: event.role, content: "" },
        },
      };

    case EventType.TEXT_MESSAGE_CONTENT: {
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

    case EventType.REASONING_MESSAGE_CONTENT:
      return appendContentPart(state, "reasoning", event.messageId, event.delta);

    case EventType.TEXT_MESSAGE_END: {
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
        streaming: draft.role === "assistant" ? initialStreaming : state.streaming,
        messageDrafts,
      };
    }

    case EventType.TOOL_CALL_START: {
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

    case EventType.TOOL_CALL_ARGS: {
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

    case EventType.TOOL_CALL_END: {
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

    case EventType.TOOL_CALL_RESULT: {
      const toolName =
        internalState.toolCallDrafts[event.toolCallId]?.name ??
        state.messages
          .find((message) => message.role === "assistant")
          ?.tool_calls?.find((call) => call.id === event.toolCallId)?.function.name;
      if (!toolName) {
        // A checkpoint may begin at a settled result without replaying the
        // preceding call event. Preserve the provider snapshot and let the
        // activity projection carry the public execution result.
        return state;
      }
      // AG-UI TOOL_CALL_RESULT carries successful output. Explicit tool
      // failures are represented by the official ToolMessage.error field in
      // MESSAGES_SNAPSHOT, never inferred from output text.
      const toolMessage: Message = {
        id: event.messageId,
        role: "tool",
        tool_call_id: event.toolCallId,
        name: toolName,
        content: event.content,
        isError: false,
      };
      const updatePart = (part: MessagePart): MessagePart =>
        part.type === "tool-call" && part.callId === event.toolCallId
          ? { ...part, state: "complete", result: event.content }
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

    case EventType.RUN_FINISHED: {
      const next = {
        ...state,
        active: false,
        activeRun: null,
        streaming: initialStreaming,
      };
      return event.outcome?.type === "interrupt"
        ? addInterrupts(
            next,
            event.outcome.interrupts.map((interrupt) => {
              const facts = interruptFacts(interrupt.metadata);
              const responseContract = descriptorFact(facts?.["responseContract"]);
              const contextContract = descriptorFact(facts?.["contextContract"]);
              const placement = placementFact(facts?.["placement"]);
              return {
                id: interrupt.id,
                ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
                ...(interrupt.toolCallId !== undefined ? { toolCallId: interrupt.toolCallId } : {}),
                ...(interrupt.responseSchema !== undefined
                  ? { responseSchema: interrupt.responseSchema }
                  : {}),
                ...(typeof facts?.["bindingId"] === "string"
                  ? { bindingId: facts["bindingId"] }
                  : {}),
                ...(facts?.["context"] !== undefined ? { context: facts["context"] as Json } : {}),
                ...(responseContract !== undefined ? { responseContract } : {}),
                ...(contextContract !== undefined ? { contextContract } : {}),
                ...(placement !== undefined ? { placement } : {}),
                ...(interrupt.metadata !== undefined ? { metadata: interrupt.metadata } : {}),
              };
            }),
            observedAt,
          )
        : next;
    }

    case EventType.RUN_ERROR:
      return { ...state, error: event.message, active: false, activeRun: null };

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

    case "LOCAL_FINALIZED_PARTS":
      return {
        ...state,
        finalizedParts: { ...state.finalizedParts, [event.messageId]: event.parts },
      };

    case "LOCAL_ABORT":
      return {
        ...state,
        ...(event.message ? { messages: upsertMessage(state.messages, event.message) } : {}),
        active: false,
        activeRun: null,
        streaming: initialStreaming,
      };

    case "LOCAL_ERROR":
      return { ...state, error: event.message, active: false };

    case "LOCAL_RESET":
      return createInitialChatStateInternal();
    default:
      return state;
  }
}
