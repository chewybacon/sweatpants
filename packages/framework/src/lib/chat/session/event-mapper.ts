import type { Operation, Channel, Stream } from "effection";
import { each } from "effection";
import type { ChatPatch } from "../patches/index.ts";
import type {
  StreamEvent,
  StreamResult,
  ElicitRequestStreamEvent,
  ConversationState,
} from "./streaming.ts";
import type { Message } from "../types.ts";
import type { StreamEventEntry } from "./options.ts";

export function* mapStreamEventsToPatches(
  eventStream: Stream<unknown, void>,
  patches: Channel<ChatPatch, void>,
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<StreamResult> {
  function rememberToolCall(call: { id: string; name: string; arguments: unknown }) {
    if (!toolCalls.some((candidate) => candidate.id === call.id)) {
      toolCalls.push(call);
    }
  }

  function parseAgUiToolArguments(serialized: string): unknown {
    if (serialized.length === 0) return {};
    try {
      return JSON.parse(serialized);
    } catch {
      return serialized;
    }
  }

  function ensureAgUiConversationState() {
    if (!agUiConversationState) {
      agUiConversationState = {
        messages: [] as Message[],
        assistantContent: assistantText,
        toolCalls: [],
        serverToolResults: [],
      };
    }
    return agUiConversationState;
  }

  function setAssistantContent(content: string) {
    assistantText = content;
    ensureAgUiConversationState().assistantContent = content;
  }

  function rememberReplayTrace(event: { toolCallId: string; toolCallName: string; trace?: import('../browser-rendering/emissions.ts').ToolExecutionTrace }) {
    if (!event.trace) return;
    const state = ensureAgUiConversationState();
    const existing = state.replay?.toolTraces ?? [];
    state.replay = {
      toolTraces: [
        ...existing.filter((trace) => trace.callId !== event.toolCallId),
        { callId: event.toolCallId, toolName: event.toolCallName, trace: event.trace },
      ],
    };
  }

  let assistantText = "";
  const elicitRequests: ElicitRequestStreamEvent[] = [];
  const emissionStartedForCall = new Set<string>();
  let agUiConversationState: ConversationState | null = null;
  const toolResults: Array<{ id: string; name: string; content: string }> = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  const agUiToolCalls = new Map<
    string,
    { id: string; name: string; arguments: string; emitted: boolean }
  >();
  let activeAgUiAssistantMessageId: string | null = null;
  let allowActiveAgUiAssistantText = false;
  const seenElicitKeys = new Set<string>();

  for (const rawEvent of yield* each(eventStream)) {
    const frame = rawEvent as { lsn: number; event: StreamEvent };
    const event = frame.event;

    onStreamEvent?.({ lsn: frame.lsn, event, phase: "live", receivedAt: Date.now() });

    switch (event.type) {
      case "session_info":
        yield* patches.send({
          type: "session_info",
          capabilities: event.capabilities,
          persona: event.persona,
        });
        break;

      case "ag_ui_run_started":
        break;

      case "ag_ui_messages_snapshot": {
        const priorState = agUiConversationState as ConversationState | null;
        agUiConversationState = {
          messages: event.messages,
          assistantContent: priorState?.assistantContent ?? assistantText,
          toolCalls: priorState?.toolCalls ?? [],
          serverToolResults: priorState?.serverToolResults ?? [],
          ...(priorState?.replay ? { replay: priorState.replay } : {}),
        };
        break;
      }

      case "ag_ui_state_snapshot":
        for (const action of event.state.pendingClientActions ?? []) {
          if (
            action.kind === "elicit" &&
            action.sessionId &&
            action.elicitId &&
            action.key &&
            action.message &&
            action.schema
          ) {
            const elicitKey = `${action.toolCallId}:${action.elicitId}`;
            if (seenElicitKeys.has(elicitKey)) continue;
            seenElicitKeys.add(elicitKey);
            const elicitEvent: ElicitRequestStreamEvent = {
              type: "elicit_request",
              sessionId: action.sessionId,
              callId: action.toolCallId,
              toolName: action.toolName,
              elicitId: action.elicitId,
              key: action.key,
              message: action.message,
              schema: action.schema,
            };
            elicitRequests.push(elicitEvent);
            if (!emissionStartedForCall.has(action.toolCallId)) {
              emissionStartedForCall.add(action.toolCallId);
              yield* patches.send({ type: "elicit_start", callId: action.toolCallId, toolName: action.toolName });
            }
            yield* patches.send({
              type: "elicit",
              callId: action.toolCallId,
              elicit: {
                elicitId: action.elicitId,
                sessionId: action.sessionId,
                key: action.key,
                message: action.message,
                schema: action.schema,
                context: (action.schema as { "x-model-context"?: unknown })["x-model-context"],
                status: "pending",
                timestamp: Date.now(),
              },
            });
          }
        }
        break;

      case "elicit_request": {
        const elicitKey = `${event.callId}:${event.elicitId}`;
        if (seenElicitKeys.has(elicitKey)) break;
        seenElicitKeys.add(elicitKey);
        elicitRequests.push(event);
        if (!emissionStartedForCall.has(event.callId)) {
          emissionStartedForCall.add(event.callId);
          yield* patches.send({ type: "elicit_start", callId: event.callId, toolName: event.toolName });
        }
        yield* patches.send({
          type: "elicit",
          callId: event.callId,
          elicit: {
            elicitId: event.elicitId,
            sessionId: event.sessionId,
            key: event.key,
            message: event.message,
            schema: event.schema,
            context: (event.schema as { "x-model-context"?: unknown })["x-model-context"],
            status: "pending",
            timestamp: Date.now(),
          },
        });
        break;
      }

      case "ag_ui_checkpoint":
        agUiConversationState = {
          messages: event.checkpoint.messages.messages,
          assistantContent: event.checkpoint.state.assistantContent,
          toolCalls: event.checkpoint.state.toolCalls,
          serverToolResults: event.checkpoint.state.serverToolResults,
          ...(event.checkpoint.state.replay ? { replay: event.checkpoint.state.replay } : {}),
        };
        for (const toolCall of event.checkpoint.state.toolCalls) {
          if (agUiToolCalls.get(toolCall.id)?.emitted) continue;
          rememberToolCall({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments });
          agUiToolCalls.set(toolCall.id, {
            id: toolCall.id,
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
            emitted: true,
          });
          yield* patches.send({
            type: "tool_call_start",
            call: { id: toolCall.id, name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
          });
        }
        break;

      case "ag_ui_text_message_start":
        if (event.role === "assistant") {
          activeAgUiAssistantMessageId = event.messageId;
          allowActiveAgUiAssistantText = true;
        }
        break;

      case "ag_ui_text_message_content":
        if (allowActiveAgUiAssistantText && event.messageId === activeAgUiAssistantMessageId) {
          setAssistantContent(`${assistantText}${event.delta}`);
          yield* patches.send({ type: "streaming_text", content: event.delta });
        }
        break;

      case "ag_ui_text_message_end":
        if (event.messageId === activeAgUiAssistantMessageId) {
          activeAgUiAssistantMessageId = null;
          allowActiveAgUiAssistantText = false;
        }
        break;

      case "ag_ui_tool_call_start": {
        const existing = agUiToolCalls.get(event.toolCallId);
        agUiToolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolCallName,
          arguments: existing?.arguments ?? "",
          emitted: existing?.emitted ?? false,
        });
        break;
      }

      case "ag_ui_tool_call_args": {
        const existing = agUiToolCalls.get(event.toolCallId);
        agUiToolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: existing?.name ?? "",
          arguments: `${existing?.arguments ?? ""}${event.delta}`,
          emitted: existing?.emitted ?? false,
        });
        break;
      }

      case "ag_ui_tool_call_end": {
        const toolCall = agUiToolCalls.get(event.toolCallId);
        if (!toolCall || toolCall.emitted) break;
        rememberToolCall({ id: toolCall.id, name: toolCall.name, arguments: parseAgUiToolArguments(toolCall.arguments) });
        ensureAgUiConversationState().toolCalls = toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments as Record<string, unknown>,
        }));
        yield* patches.send({
          type: "tool_call_start",
          call: { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
        });
        agUiToolCalls.set(event.toolCallId, { ...toolCall, emitted: true });
        break;
      }

      case "thinking":
        yield* patches.send({ type: "streaming_reasoning", content: event.content });
        break;

      case "ag_ui_tool_call_result":
        toolResults.push({ id: event.toolCallId, name: event.toolCallName, content: event.content });
        rememberReplayTrace(event);
        ensureAgUiConversationState().serverToolResults = toolResults.map((result) => ({
          id: result.id,
          name: result.name,
          content: result.content,
          isError: false,
        }));
        yield* patches.send({ type: "tool_call_result", id: event.toolCallId, result: event.content });
        yield* patches.send({ type: "elicit_complete", callId: event.toolCallId });
        break;

      case "ag_ui_tool_call_error":
        yield* patches.send({ type: "tool_call_error", id: event.toolCallId, error: event.message });
        yield* patches.send({ type: "elicit_complete", callId: event.toolCallId });
        break;

      case "ag_ui_run_finished":
        activeAgUiAssistantMessageId = null;
        allowActiveAgUiAssistantText = false;
        setAssistantContent(assistantText);
        break;

      case "error":
        yield* patches.send({ type: "error", message: event.message });
        if (!event.recoverable) throw new Error(event.message);
        break;

      case "tool_session_status":
        break;

      case "tool_session_error":
        yield* patches.send({ type: "error", message: event.message });
        break;
    }

    yield* each.next();
  }

  if (elicitRequests.length > 0) {
    const state = agUiConversationState ?? {
      messages: [],
      assistantContent: assistantText,
      toolCalls: toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments as Record<string, unknown>,
      })),
      serverToolResults: [],
    };
    return { type: "elicit", pendingElicitations: elicitRequests, conversationState: state };
  }

  return {
    type: "complete",
    text: assistantText,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolResults.length > 0 ? { toolResults } : {}),
    ...(agUiConversationState ? { conversationState: agUiConversationState } : {}),
  };
}
