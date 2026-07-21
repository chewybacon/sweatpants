import type { Operation, Channel, Stream } from "effection";
import { each } from "effection";
import type { ToolExecutionTrace } from "../browser-rendering/emissions.ts";
import type { ChatPatch } from "../patches/index.ts";
import type {
  StreamEvent,
  StreamResult,
  ElicitRequestStreamEvent,
  ConversationState,
} from "./streaming.ts";
import type { Message } from "../types.ts";
import type { StreamEventEntry } from "./options.ts";
import { agUiMessagesToInternalMessages } from "./ag-ui-messages.ts";
import { providerHistoryMessages } from "./ag-ui-projection.ts";
import {
  activityMessageToPluginReplayTrace,
  activitySnapshotToPluginReplayTrace,
} from "./plugin-replay.ts";

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

  function rememberReplayTrace(event: {
    toolCallId: string;
    toolCallName: string;
    trace?: ToolExecutionTrace;
  }) {
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

  function rememberActivityReplayTrace(rawEvent: unknown) {
    const replayTrace = activitySnapshotToPluginReplayTrace(rawEvent);
    if (!replayTrace) return;
    const state = ensureAgUiConversationState();
    const existing = state.replay?.toolTraces ?? [];
    state.replay = {
      toolTraces: [...existing.filter((trace) => trace.callId !== replayTrace.callId), replayTrace],
    };
  }

  function metadataString(
    metadata: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    const value = metadata?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  function emitInterruptElicit(interrupt: {
    id: string;
    reason: string;
    message?: string;
    toolCallId?: string;
    responseSchema?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }) {
    const callId = interrupt.toolCallId ?? interrupt.id;
    const toolName = metadataString(interrupt.metadata, "sweatpants/toolName") ?? "unknown";
    const key = metadataString(interrupt.metadata, "sweatpants/key") ?? interrupt.id;
    const sessionId = callId;
    const elicitEvent: ElicitRequestStreamEvent = {
      type: "elicit_request",
      sessionId,
      callId,
      toolName,
      elicitId: interrupt.id,
      key,
      message: interrupt.message ?? "Input required",
      schema: interrupt.responseSchema ?? {},
    };
    return elicitEvent;
  }

  let assistantText = "";
  let toolHostAssistantText = "";
  const elicitRequests: ElicitRequestStreamEvent[] = [];
  const emissionStartedForCall = new Set<string>();
  let agUiConversationState: ConversationState | null = null;
  const toolResults: Array<{ id: string; name: string; content: string }> = [];
  const toolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  const agUiToolCalls = new Map<
    string,
    { id: string; name: string; arguments: string; emitted: boolean }
  >();
  const hostedToolCallIds = new Set<string>();
  let activeAgUiAssistantMessageId: string | null = null;
  let allowActiveAgUiAssistantText = false;
  const seenElicitKeys = new Set<string>();

  function ensureAssistantToolHostMessage() {
    const pendingHostToolCalls = toolCalls.filter(
      (toolCall) => !hostedToolCallIds.has(toolCall.id),
    );
    if (pendingHostToolCalls.length === 0) return;
    const state = ensureAgUiConversationState();
    const toolCallIds = pendingHostToolCalls.map((toolCall) => toolCall.id);
    const alreadyPresent = state.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.tool_calls &&
        message.tool_calls.length === toolCallIds.length &&
        toolCallIds.every((id) => message.tool_calls!.some((toolCall) => toolCall.id === id)),
    );
    for (const id of toolCallIds) hostedToolCallIds.add(id);
    const hostedAssistantText = toolHostAssistantText;
    toolHostAssistantText = "";
    if (alreadyPresent) return;
    state.messages.push({
      id: `assistant:tools:${toolCallIds.join(":")}`,
      role: "assistant",
      content: hostedAssistantText,
      tool_calls: pendingHostToolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function" as const,
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments as Record<string, unknown>,
        },
      })),
    });
  }

  function ensureToolResultMessage(toolCallId: string, content: string, toolName: string) {
    const state = ensureAgUiConversationState();
    if (
      state.messages.some(
        (message) => message.role === "tool" && message.tool_call_id === toolCallId,
      )
    ) {
      return;
    }
    state.messages.push({
      id: `tool:${toolCallId}`,
      role: "tool",
      tool_call_id: toolCallId,
      content,
      replay: { toolName },
    });
  }

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

      case "RUN_STARTED":
      case "ag_ui_run_started":
        break;

      case "MESSAGES_SNAPSHOT": {
        const priorState = agUiConversationState as ConversationState | null;
        agUiConversationState = {
          messages: agUiMessagesToInternalMessages(event.messages).filter(
            (message) => message.role !== "activity",
          ),
          assistantContent: priorState?.assistantContent ?? assistantText,
          toolCalls: priorState?.toolCalls ?? [],
          serverToolResults: priorState?.serverToolResults ?? [],
          ...(priorState?.replay ? { replay: priorState.replay } : {}),
        };
        for (const message of event.messages) {
          const replayTrace = activityMessageToPluginReplayTrace(message);
          if (!replayTrace) continue;
          const state = ensureAgUiConversationState();
          const existing = state.replay?.toolTraces ?? [];
          state.replay = {
            toolTraces: [
              ...existing.filter((trace) => trace.callId !== replayTrace.callId),
              replayTrace,
            ],
          };
        }
        break;
      }

      case "ag_ui_messages_snapshot": {
        const priorState = agUiConversationState as ConversationState | null;
        for (const message of event.messages) {
          const replayTrace = activityMessageToPluginReplayTrace(message);
          if (replayTrace)
            rememberActivityReplayTrace({
              type: "ACTIVITY_SNAPSHOT",
              messageId: `sweatpants:plugin-replay:${replayTrace.callId}`,
              activityType: "sweatpants:plugin-replay",
              content: {
                version: 1,
                toolCallId: replayTrace.callId,
                toolName: replayTrace.toolName,
                trace: replayTrace.trace,
              },
              replace: true,
            });
        }
        agUiConversationState = {
          messages: providerHistoryMessages(event.messages),
          assistantContent: priorState?.assistantContent ?? assistantText,
          toolCalls: priorState?.toolCalls ?? [],
          serverToolResults: priorState?.serverToolResults ?? [],
          ...(priorState?.replay ? { replay: priorState.replay } : {}),
        };
        break;
      }

      case "STATE_SNAPSHOT":
        for (const action of event.snapshot.pendingClientActions ?? []) {
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
              yield* patches.send({
                type: "elicit_start",
                callId: action.toolCallId,
                toolName: action.toolName,
              });
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
                context: (action.schema as { "x-elicit-context"?: unknown })["x-elicit-context"],
                status: "pending",
                timestamp: Date.now(),
              },
            });
          }
        }
        break;

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
              yield* patches.send({
                type: "elicit_start",
                callId: action.toolCallId,
                toolName: action.toolName,
              });
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
                context: (action.schema as { "x-elicit-context"?: unknown })["x-elicit-context"],
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
          yield* patches.send({
            type: "elicit_start",
            callId: event.callId,
            toolName: event.toolName,
          });
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
            context: (event.schema as { "x-elicit-context"?: unknown })["x-elicit-context"],
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
            call: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: JSON.stringify(toolCall.arguments),
            },
          });
        }
        break;

      case "TEXT_MESSAGE_START":
      case "ag_ui_text_message_start":
        if (event.role === "assistant") {
          activeAgUiAssistantMessageId = event.messageId;
          allowActiveAgUiAssistantText = true;
        }
        break;

      case "TEXT_MESSAGE_CONTENT":
      case "ag_ui_text_message_content":
        if (allowActiveAgUiAssistantText && event.messageId === activeAgUiAssistantMessageId) {
          setAssistantContent(`${assistantText}${event.delta}`);
          yield* patches.send({ type: "streaming_text", content: event.delta });
        }
        break;

      case "TEXT_MESSAGE_END":
      case "ag_ui_text_message_end":
        if (event.messageId === activeAgUiAssistantMessageId) {
          activeAgUiAssistantMessageId = null;
          allowActiveAgUiAssistantText = false;
        }
        break;

      case "TOOL_CALL_START":
      case "ag_ui_tool_call_start": {
        const hasUnhostedToolCall = [...agUiToolCalls.values()].some(
          (toolCall) => !hostedToolCallIds.has(toolCall.id),
        );
        if (!hasUnhostedToolCall) {
          toolHostAssistantText = assistantText;
          setAssistantContent("");
        }
        const existing = agUiToolCalls.get(event.toolCallId);
        agUiToolCalls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolCallName,
          arguments: existing?.arguments ?? "",
          emitted: existing?.emitted ?? false,
        });
        break;
      }

      case "TOOL_CALL_ARGS":
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

      case "TOOL_CALL_END":
      case "ag_ui_tool_call_end": {
        const toolCall = agUiToolCalls.get(event.toolCallId);
        if (!toolCall || toolCall.emitted) break;
        rememberToolCall({
          id: toolCall.id,
          name: toolCall.name,
          arguments: parseAgUiToolArguments(toolCall.arguments),
        });
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

      case "REASONING_MESSAGE_CONTENT":
        yield* patches.send({ type: "streaming_reasoning", content: event.delta });
        break;

      case "thinking":
        yield* patches.send({ type: "streaming_reasoning", content: event.content });
        break;

      case "ACTIVITY_SNAPSHOT":
        rememberActivityReplayTrace(event);
        break;

      case "TOOL_CALL_RESULT": {
        const knownToolCall = agUiToolCalls.get(event.toolCallId);
        const toolCallName = event.toolCallName ?? knownToolCall?.name ?? "unknown";
        toolResults.push({ id: event.toolCallId, name: toolCallName, content: event.content });
        ensureAssistantToolHostMessage();
        ensureToolResultMessage(event.toolCallId, event.content, toolCallName);
        ensureAgUiConversationState().serverToolResults = toolResults.map((result) => ({
          id: result.id,
          name: result.name,
          content: result.content,
          isError: result.content.startsWith("Error:"),
        }));
        if (event.content.startsWith("Error:")) {
          yield* patches.send({
            type: "tool_call_error",
            id: event.toolCallId,
            error: event.content,
          });
        } else {
          yield* patches.send({
            type: "tool_call_result",
            id: event.toolCallId,
            result: event.content,
          });
        }
        yield* patches.send({ type: "elicit_complete", callId: event.toolCallId });
        break;
      }

      case "ag_ui_tool_call_result":
        toolResults.push({
          id: event.toolCallId,
          name: event.toolCallName,
          content: event.content,
        });
        rememberReplayTrace(event);
        ensureAssistantToolHostMessage();
        ensureToolResultMessage(event.toolCallId, event.content, event.toolCallName);
        ensureAgUiConversationState().serverToolResults = toolResults.map((result) => ({
          id: result.id,
          name: result.name,
          content: result.content,
          isError: false,
        }));
        yield* patches.send({
          type: "tool_call_result",
          id: event.toolCallId,
          result: event.content,
        });
        yield* patches.send({ type: "elicit_complete", callId: event.toolCallId });
        break;

      case "ag_ui_tool_call_error":
        yield* patches.send({
          type: "tool_call_error",
          id: event.toolCallId,
          error: event.message,
        });
        yield* patches.send({ type: "elicit_complete", callId: event.toolCallId });
        break;

      case "RUN_FINISHED":
        activeAgUiAssistantMessageId = null;
        allowActiveAgUiAssistantText = false;
        setAssistantContent(assistantText);
        ensureAssistantToolHostMessage();
        toolHostAssistantText = "";
        if (event.outcome?.type === "interrupt") {
          for (const interrupt of event.outcome.interrupts) {
            const elicitEvent = emitInterruptElicit(interrupt);
            const elicitKey = `${elicitEvent.callId}:${elicitEvent.elicitId}`;
            if (seenElicitKeys.has(elicitKey)) continue;
            seenElicitKeys.add(elicitKey);
            elicitRequests.push(elicitEvent);
            if (!emissionStartedForCall.has(elicitEvent.callId)) {
              emissionStartedForCall.add(elicitEvent.callId);
              yield* patches.send({
                type: "elicit_start",
                callId: elicitEvent.callId,
                toolName: elicitEvent.toolName,
              });
            }
            yield* patches.send({
              type: "elicit",
              callId: elicitEvent.callId,
              elicit: {
                elicitId: elicitEvent.elicitId,
                sessionId: elicitEvent.sessionId,
                key: elicitEvent.key,
                message: elicitEvent.message,
                schema: elicitEvent.schema,
                context: (elicitEvent.schema as { "x-elicit-context"?: unknown })["x-elicit-context"],
                status: "pending",
                timestamp: Date.now(),
              },
            });
          }
        }
        break;

      case "ag_ui_run_finished":
        activeAgUiAssistantMessageId = null;
        allowActiveAgUiAssistantText = false;
        setAssistantContent(assistantText);
        toolHostAssistantText = "";
        break;

      case "RUN_ERROR":
        yield* patches.send({ type: "error", message: event.message });
        throw new Error(event.message);

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
