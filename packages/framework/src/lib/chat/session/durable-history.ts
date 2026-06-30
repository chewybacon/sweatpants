import type { Operation } from "effection";
import { call } from "effection";
import type { ChatPatch } from "../patches/index.ts";
import type {
  HydratedToolExecutionTrace,
  ToolExecutionTrace,
} from "../browser-rendering/emissions.ts";
import type { Message } from "../types.ts";
import type { ConversationReplayState, StreamEvent } from "./streaming.ts";
import type { PatchTransform, StreamEventEntry } from "./options.ts";
import { renderReplayMessageParts } from "./replay-render.ts";
import type { MessagePart, ToolCallPart, ChatEmission } from "../types/chat-message.ts";
import {
  assertMessageHasId,
  deriveTurnKeyFromToolCalls,
  messageIdForAssistantFinal,
  messageIdForAssistantTools,
  messageIdForTool,
} from "./message-identity.ts";
import { createTranscriptState, resetTranscriptState } from "./transcript.ts";
import { agUiMessagesToInternalMessages } from "./ag-ui-compat.ts";
import {
  activitySnapshotToPluginReplayTrace,
  activityMessageToPluginReplayTrace,
} from "./plugin-replay.ts";

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
  transforms?: PatchTransform[];
  onStreamEvent?: (entry: StreamEventEntry) => void;
}

export interface DurableHistoryReplay {
  patches: ChatPatch[];
  history: Message[];
  replayState?: ConversationReplayState;
}

function mergeReplayState(
  current: ConversationReplayState | undefined,
  incoming: ConversationReplayState | undefined,
): ConversationReplayState | undefined {
  const merged = new Map<string, ConversationReplayState["toolTraces"][number]>();

  for (const trace of current?.toolTraces ?? []) {
    merged.set(trace.callId, trace);
  }

  for (const trace of incoming?.toolTraces ?? []) {
    merged.set(trace.callId, trace);
  }

  return merged.size > 0 ? { toolTraces: Array.from(merged.values()) } : undefined;
}

function toolResultContent(content: string): string {
  return content.startsWith("Error:") ? content : content;
}

export function deduplicateMessages(messages: Message[]): Message[] {
  const seen = new Map<string, number>();
  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === "tool" && msg.tool_call_id) {
      const existingIdx = seen.get(msg.tool_call_id);
      if (existingIdx !== undefined) {
        const existing = result[existingIdx]!;
        if (msg.replay && !existing.replay) {
          result[existingIdx] = msg;
        }
        continue;
      }
      seen.set(msg.tool_call_id, result.length);
      result.push(msg);
    } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const key = msg.tool_calls
        .map((tc) => tc.id)
        .sort()
        .join(",");
      const existingIdx = seen.get(`assistant-tools:${key}`);
      if (existingIdx !== undefined) {
        continue;
      }
      seen.set(`assistant-tools:${key}`, result.length);
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  return result;
}

function isReplayableTool(value: unknown): value is ReplayableTool {
  return !!value && (typeof value === "object" || typeof value === "function") && "name" in value;
}

function* replayToolTrace(
  tools: unknown[] | undefined,
  toolName: string,
  trace: ToolExecutionTrace | undefined,
): Operation<HydratedToolExecutionTrace | null> {
  if (!trace || !tools?.length) {
    return null;
  }

  const tool = tools.find(
    (candidate): candidate is ReplayableTool =>
      isReplayableTool(candidate) && candidate.name === toolName,
  );
  if (!tool?.replayTrace) {
    return null;
  }

  return yield* tool.replayTrace(trace);
}

function buildReplayEmissions(
  callId: string,
  hydratedTrace: HydratedToolExecutionTrace | null,
): ChatEmission[] {
  if (!hydratedTrace) {
    return [];
  }

  const emissions: ChatEmission[] = [];

  for (const entry of hydratedTrace.emissions) {
    if (!entry._component) {
      continue;
    }

    emissions.push({
      id: entry.emissionId ?? `${callId}-replay-${entry.order + 1}`,
      status: "complete",
      component: entry._component,
      props: entry.props,
      ...(entry.response !== undefined ? { response: entry.response } : {}),
    });
  }

  return emissions;
}

function* buildAssistantReplayParts(
  message: Message,
  toolResults: Message[],
  replayToolTraceByCallId: Map<string, ConversationReplayState["toolTraces"][number]>,
  tools: unknown[] | undefined,
  transforms: PatchTransform[] | undefined,
): Operation<MessagePart[] | undefined> {
  if (message.role !== "assistant") {
    return undefined;
  }

  const contentParts = (yield* renderReplayMessageParts(message.content, transforms)) ?? [];
  if (!message.tool_calls?.length) {
    return contentParts.length > 0 ? contentParts : undefined;
  }

  const toolParts: ToolCallPart[] = [];

  for (const toolCall of message.tool_calls) {
    const toolResult = toolResults.find((candidate) => candidate.tool_call_id === toolCall.id);
    const error = toolResult?.content?.startsWith("Error:") ? toolResult.content : undefined;
    const replayedTrace = replayToolTraceByCallId.get(toolCall.id);
    const hydratedTrace = replayedTrace
      ? yield* replayToolTrace(tools, replayedTrace.toolName, replayedTrace.trace)
      : null;

    toolParts.push({
      id: `${assertMessageHasId(message, "assistant replay parts")}-tool-${toolCall.id}`,
      type: "tool-call",
      callId: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
      state: toolResult ? (error ? "error" : "complete") : "running",
      ...(toolResult && !error ? { result: toolResult.content } : {}),
      ...(error ? { error } : {}),
      emissions: buildReplayEmissions(toolCall.id, hydratedTrace),
      pluginElicits: [],
    });
  }

  const parts = [...contentParts, ...toolParts];
  return parts.length > 0 ? parts : undefined;
}

export function* replayFramesToConversation(
  frames: DurableFrame[],
  tools?: unknown[],
  transforms?: PatchTransform[],
  onStreamEvent?: (entry: StreamEventEntry) => void,
): Operation<DurableHistoryReplay> {
  const patches: ChatPatch[] = [];
  const history: Message[] = [];
  const transcriptState = createTranscriptState(history);
  let currentAssistantText = "";
  let pendingToolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
  let seededFromConversationState = false;
  let seededToolCallIds: Set<string> = new Set();
  let seededAssistantContent: Set<string> = new Set();
  let replayState: ConversationReplayState | undefined = undefined;
  const emittedReplayCallIds = new Set<string>();

  function toolNameForCall(toolCallId: string, fallback = "unknown"): string {
    return (
      pendingToolCalls.find((toolCall) => toolCall.id === toolCallId)?.name ??
      replayState?.toolTraces.find((trace) => trace.callId === toolCallId)?.toolName ??
      fallback
    );
  }

  function* emitReplayEmissionPatches(
    replayTrace: ConversationReplayState["toolTraces"][number],
  ): Operation<void> {
    if (emittedReplayCallIds.has(replayTrace.callId)) {
      return;
    }
    const replayedTrace = yield* replayToolTrace(tools, replayTrace.toolName, replayTrace.trace);
    if (!replayedTrace) {
      return;
    }
    emittedReplayCallIds.add(replayTrace.callId);
    patches.push({
      type: "tool_emission_start",
      callId: replayTrace.callId,
      toolName: replayTrace.toolName,
    });
    for (const entry of replayedTrace.emissions) {
      patches.push({
        type: "tool_emission",
        callId: replayTrace.callId,
        toolName: replayTrace.toolName,
        emission: {
          id: entry.emissionId ?? `${replayTrace.callId}-replay-${entry.order + 1}`,
          type: "__component__",
          payload: {
            componentKey: entry.componentKey,
            props: entry.props,
            ...(entry._component && { _component: entry._component }),
          },
          status: "complete",
          timestamp: entry.timestamp,
          ...(entry.response !== undefined ? { response: entry.response } : {}),
        },
      });
    }
    patches.push({
      type: "tool_emission_complete",
      callId: replayTrace.callId,
      trace: replayedTrace,
    });
  }

  for (const frame of frames) {
    const event = frame.event;

    onStreamEvent?.({
      lsn: frame.lsn,
      event,
      phase: "replay",
      receivedAt: Date.now(),
    });

    switch (event.type) {
      case "session_info": {
        patches.push({
          type: "session_info",
          capabilities: event.capabilities,
          persona: event.persona,
        });
        break;
      }

      case "thinking": {
        break;
      }

      case "REASONING_MESSAGE_CONTENT": {
        break;
      }

      case "MESSAGES_SNAPSHOT": {
        const activityReplayState: ConversationReplayState = {
          toolTraces: event.messages
            .map(activityMessageToPluginReplayTrace)
            .filter(
              (trace): trace is ConversationReplayState["toolTraces"][number] => trace !== null,
            ),
        };
        replayState = mergeReplayState(replayState, activityReplayState);

        if (!seededFromConversationState && history.length === 0) {
          const messages = deduplicateMessages(agUiMessagesToInternalMessages(event.messages));
          const replayToolTraceByCallId = new Map(
            (replayState?.toolTraces ?? []).map((trace) => [trace.callId, trace]),
          );
          const toolResults = messages.filter((candidate) => candidate.role === "tool");

          for (const message of messages) {
            assertMessageHasId(message, "MESSAGES_SNAPSHOT seed");
            if (message.role === "tool" && message.tool_call_id)
              seededToolCallIds.add(message.tool_call_id);
            if (message.role === "assistant" && message.content)
              seededAssistantContent.add(message.content);
            if (message.role === "assistant" && message.tool_calls) {
              for (const toolCall of message.tool_calls) seededToolCallIds.add(toolCall.id);
            }
            const assistantParts = yield* buildAssistantReplayParts(
              message,
              toolResults,
              replayToolTraceByCallId,
              tools,
              transforms,
            );
            history.push(message);
            resetTranscriptState(transcriptState, history);
            patches.push({
              type: "history_message",
              message,
              ...(assistantParts ? { parts: assistantParts } : {}),
            });
          }
          seededFromConversationState = messages.length > 0;
        }
        break;
      }

      case "TEXT_MESSAGE_CONTENT":
      case "ag_ui_text_message_content": {
        currentAssistantText += event.delta;
        break;
      }

      case "TOOL_CALL_START":
      case "ag_ui_tool_call_start": {
        pendingToolCalls.push({
          id: event.toolCallId,
          name: event.toolCallName,
          arguments: undefined,
        });
        break;
      }

      case "TOOL_CALL_ARGS":
      case "ag_ui_tool_call_args": {
        const pending = pendingToolCalls.find((tc) => tc.id === event.toolCallId);
        if (pending) {
          try {
            pending.arguments = JSON.parse(event.delta);
          } catch {
            pending.arguments = event.delta;
          }
        }
        break;
      }

      case "ACTIVITY_SNAPSHOT": {
        const replayTrace = activitySnapshotToPluginReplayTrace(event);
        if (replayTrace) {
          replayState = mergeReplayState(replayState, { toolTraces: [replayTrace] });
          yield* emitReplayEmissionPatches(replayTrace);
        }
        break;
      }

      case "TOOL_CALL_RESULT": {
        const trace = replayState?.toolTraces.find(
          (candidate) => candidate.callId === event.toolCallId,
        );
        const alreadySeeded =
          seededFromConversationState &&
          history.some((m) => m.role === "tool" && m.tool_call_id === event.toolCallId);

        if (!alreadySeeded) {
          const toolMessage: Message = {
            id: messageIdForTool(event.toolCallId),
            role: "tool",
            tool_call_id: event.toolCallId,
            content: toolResultContent(event.content),
          };

          history.push(toolMessage);
          transcriptState.currentTurnKey = event.toolCallId;
          patches.push({
            type: "history_message",
            message: toolMessage,
          });
          if (trace) {
            yield* emitReplayEmissionPatches(trace);
          }
        }
        break;
      }

      case "ag_ui_tool_call_result": {
        replayState = mergeReplayState(replayState, {
          toolTraces: event.trace
            ? [{ callId: event.toolCallId, toolName: event.toolCallName, trace: event.trace }]
            : [],
        });

        const alreadySeeded =
          seededFromConversationState &&
          history.some((m) => m.role === "tool" && m.tool_call_id === event.toolCallId);

        if (!alreadySeeded) {
          const replayedTrace = yield* replayToolTrace(tools, event.toolCallName, event.trace);

          const toolMessage: Message = {
            id: messageIdForTool(event.toolCallId),
            role: "tool",
            tool_call_id: event.toolCallId,
            content: toolResultContent(event.content),
          };

          history.push(toolMessage);
          transcriptState.currentTurnKey = event.toolCallId;
          patches.push({
            type: "history_message",
            message: toolMessage,
          });
          if (replayedTrace) {
            patches.push({
              type: "tool_emission_start",
              callId: event.toolCallId,
              toolName: event.toolCallName,
            });
            for (const entry of replayedTrace.emissions) {
              patches.push({
                type: "tool_emission",
                callId: event.toolCallId,
                toolName: event.toolCallName,
                emission: {
                  id: entry.emissionId ?? `${event.toolCallId}-replay-${entry.order + 1}`,
                  type: "__component__",
                  payload: {
                    componentKey: entry.componentKey,
                    props: entry.props,
                    ...(entry._component && { _component: entry._component }),
                  },
                  status: "complete",
                  timestamp: entry.timestamp,
                  ...(entry.response !== undefined ? { response: entry.response } : {}),
                },
              });
            }
            patches.push({
              type: "tool_emission_complete",
              callId: event.toolCallId,
              trace: replayedTrace,
            });
          }
        }
        break;
      }

      case "ag_ui_tool_call_error": {
        const toolErrorMessage: Message = {
          id: messageIdForTool(event.toolCallId),
          role: "tool",
          tool_call_id: event.toolCallId,
          content: `Error: ${event.message}`,
        };

        history.push(toolErrorMessage);
        transcriptState.currentTurnKey = event.toolCallId;
        patches.push({
          type: "history_message",
          message: toolErrorMessage,
        });
        break;
      }

      case "RUN_FINISHED":
      case "ag_ui_run_finished": {
        const assistantText = currentAssistantText;

        if (pendingToolCalls.length > 0) {
          const toolCallIds = pendingToolCalls.map((call) => call.id);

          const alreadySeeded =
            seededFromConversationState && toolCallIds.every((id) => seededToolCallIds.has(id));

          const alreadyInHistory = history.some(
            (m) =>
              m.role === "assistant" &&
              m.tool_calls &&
              m.tool_calls.length === toolCallIds.length &&
              toolCallIds.every((id) => m.tool_calls!.some((tc) => tc.id === id)),
          );

          if (!alreadySeeded && !alreadyInHistory) {
            const assistantWithTools: Message = {
              id: messageIdForAssistantTools(toolCallIds),
              role: "assistant",
              content: assistantText,
              tool_calls: pendingToolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: call.arguments as Record<string, unknown>,
                },
              })),
            };

            const parts = yield* renderReplayMessageParts(assistantText, transforms);

            history.push(assistantWithTools);
            transcriptState.currentTurnKey = deriveTurnKeyFromToolCalls(toolCallIds);
            patches.push({
              type: "history_message",
              message: assistantWithTools,
              ...(parts ? { parts } : {}),
            });
          }
        } else if (assistantText) {
          const alreadySeeded =
            seededFromConversationState && seededAssistantContent.has(assistantText);

          const alreadyInHistory = history.some(
            (m) => m.role === "assistant" && m.content === assistantText,
          );

          if (!alreadySeeded && !alreadyInHistory) {
            const assistantMessage: Message = {
              id: messageIdForAssistantFinal(transcriptState.currentTurnKey),
              role: "assistant",
              content: assistantText,
            };

            const parts = yield* renderReplayMessageParts(assistantText, transforms);

            history.push(assistantMessage);
            patches.push({
              type: "history_message",
              message: assistantMessage,
              ...(parts ? { parts } : {}),
            });
          }
        }

        if (event.type === "RUN_FINISHED" && event.outcome?.type === "interrupt") {
          for (const interrupt of event.outcome.interrupts) {
            const metadata = interrupt.metadata ?? {};
            const callId = interrupt.toolCallId ?? interrupt.id;
            const toolName =
              typeof metadata["sweatpants/toolName"] === "string"
                ? metadata["sweatpants/toolName"]
                : toolNameForCall(callId);
            const key =
              typeof metadata["sweatpants/key"] === "string"
                ? metadata["sweatpants/key"]
                : interrupt.id;
            const sessionId =
              typeof metadata["sweatpants/sessionId"] === "string"
                ? metadata["sweatpants/sessionId"]
                : callId;
            if (
              !patches.some((patch) => patch.type === "elicit_start" && patch.callId === callId)
            ) {
              patches.push({ type: "elicit_start", callId, toolName });
            }
            patches.push({
              type: "elicit",
              callId,
              elicit: {
                elicitId: interrupt.id,
                sessionId,
                key,
                message: interrupt.message ?? "Input required",
                schema: interrupt.responseSchema ?? {},
                context: (
                  interrupt.responseSchema as { "x-model-context"?: unknown } | undefined
                )?.["x-model-context"],
                status: "pending",
                timestamp: Date.now(),
              },
            });
          }
        }

        currentAssistantText = "";
        pendingToolCalls = [];
        break;
      }

      case "RUN_ERROR":
      case "error": {
        patches.push({
          type: "error",
          message: event.message,
        });
        break;
      }

      case "ag_ui_checkpoint": {
        const checkpointConversationState = {
          messages: event.checkpoint.messages.messages,
          assistantContent: event.checkpoint.state.assistantContent,
          toolCalls: event.checkpoint.state.toolCalls,
          serverToolResults: event.checkpoint.state.serverToolResults,
          ...(event.checkpoint.state.replay ? { replay: event.checkpoint.state.replay } : {}),
        };

        replayState = mergeReplayState(replayState, checkpointConversationState.replay);

        if (
          !seededFromConversationState &&
          history.length === 0 &&
          checkpointConversationState.messages.length > 0
        ) {
          // Initial seed — populate history from checkpoint messages
          const replayToolTraceByCallId = new Map(
            (checkpointConversationState.replay?.toolTraces ?? []).map((trace) => [
              trace.callId,
              trace,
            ]),
          );

          const dedupedMessages = deduplicateMessages(checkpointConversationState.messages);

          for (const message of dedupedMessages) {
            assertMessageHasId(message, "ag_ui_checkpoint seed");
            if (message.role === "tool" && message.tool_call_id) {
              seededToolCallIds.add(message.tool_call_id);
            }
            if (message.role === "assistant" && message.content) {
              seededAssistantContent.add(message.content);
            }
            if (message.role === "assistant" && message.tool_calls) {
              for (const tc of message.tool_calls) {
                seededToolCallIds.add(tc.id);
              }
            }

            const toolResults = dedupedMessages.filter((candidate) => candidate.role === "tool");
            const assistantParts = yield* buildAssistantReplayParts(
              message,
              toolResults,
              replayToolTraceByCallId,
              tools,
              transforms,
            );

            history.push(message);
            resetTranscriptState(transcriptState, history);
            patches.push({
              type: "history_message",
              message,
              ...(assistantParts ? { parts: assistantParts } : {}),
            });
          }
          seededFromConversationState = true;
        } else if (checkpointConversationState.messages.length > 0) {
          // Supplement — subsequent checkpoint with new messages (e.g. new user turn)
          const existingToolCallIds = new Set(
            history
              .filter((m) => m.role === "assistant" && m.tool_calls)
              .flatMap((m) => m.tool_calls!.map((tc) => tc.id))
              .concat(
                history
                  .filter((m) => m.role === "tool" && m.tool_call_id)
                  .map((m) => m.tool_call_id!),
              ),
          );
          const existingAssistantContents = new Set(
            history.filter((m) => m.role === "assistant" && m.content).map((m) => m.content!),
          );
          const existingUserContents = new Set(
            history.filter((m) => m.role === "user" && m.content).map((m) => m.content!),
          );

          const replayToolTraceByCallId = new Map(
            (checkpointConversationState.replay?.toolTraces ?? []).map((trace) => [
              trace.callId,
              trace,
            ]),
          );

          const dedupedMessages = deduplicateMessages(checkpointConversationState.messages);

          const toolResults = dedupedMessages.filter((candidate) => candidate.role === "tool");

          for (const message of dedupedMessages) {
            assertMessageHasId(message, "ag_ui_checkpoint supplement");
            let isDuplicate = false;

            if (message.role === "tool" && message.tool_call_id) {
              seededToolCallIds.add(message.tool_call_id);
              isDuplicate = existingToolCallIds.has(message.tool_call_id);
            } else if (
              message.role === "assistant" &&
              message.tool_calls &&
              message.tool_calls.length > 0
            ) {
              for (const tc of message.tool_calls) {
                seededToolCallIds.add(tc.id);
              }
              isDuplicate = message.tool_calls.every((tc) => existingToolCallIds.has(tc.id));
            } else if (message.role === "assistant" && message.content) {
              seededAssistantContent.add(message.content);
              isDuplicate = existingAssistantContents.has(message.content);
            } else if (message.role === "user" && message.content) {
              isDuplicate = existingUserContents.has(message.content);
            }

            if (!isDuplicate) {
              const assistantParts = yield* buildAssistantReplayParts(
                message,
                toolResults,
                replayToolTraceByCallId,
                tools,
                transforms,
              );

              history.push(message);
              resetTranscriptState(transcriptState, history);
              patches.push({
                type: "history_message",
                message,
                ...(assistantParts ? { parts: assistantParts } : {}),
              });
            }
          }
        }

        currentAssistantText = checkpointConversationState.assistantContent;
        pendingToolCalls = checkpointConversationState.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        }));
        break;
      }

      case "STATE_SNAPSHOT": {
        for (const action of event.snapshot.pendingClientActions ?? []) {
          if (
            action.kind === "elicit" &&
            action.sessionId &&
            action.elicitId &&
            action.key &&
            action.message &&
            action.schema
          ) {
            if (
              !patches.some(
                (patch) => patch.type === "elicit_start" && patch.callId === action.toolCallId,
              )
            ) {
              patches.push({
                type: "elicit_start",
                callId: action.toolCallId,
                toolName: action.toolName,
              });
            }

            patches.push({
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
      }

      case "ag_ui_state_snapshot": {
        for (const action of event.state.pendingClientActions ?? []) {
          if (
            action.kind === "elicit" &&
            action.sessionId &&
            action.elicitId &&
            action.key &&
            action.message &&
            action.schema
          ) {
            if (
              !patches.some(
                (patch) => patch.type === "elicit_start" && patch.callId === action.toolCallId,
              )
            ) {
              patches.push({
                type: "elicit_start",
                callId: action.toolCallId,
                toolName: action.toolName,
              });
            }

            patches.push({
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
      }

      case "RUN_STARTED":
      case "ag_ui_run_started":
      case "TEXT_MESSAGE_START":
      case "ag_ui_text_message_start":
      case "TEXT_MESSAGE_END":
      case "ag_ui_text_message_end":
      case "TOOL_CALL_END":
      case "ag_ui_tool_call_end": {
        break;
      }

      case "elicit_request": {
        if (
          !patches.some((patch) => patch.type === "elicit_start" && patch.callId === event.callId)
        ) {
          patches.push({
            type: "elicit_start",
            callId: event.callId,
            toolName: event.toolName,
          });
        }

        patches.push({
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

      case "tool_session_status":
      case "tool_session_error": {
        break;
      }
    }
  }

  return {
    patches,
    history,
    ...(replayState ? { replayState } : {}),
  };
}

export function* readDurableHistory(
  options: ReadDurableHistoryOptions,
): Operation<DurableHistoryReplay> {
  const { baseUrl, conversationId, tools, transforms, onStreamEvent } = options;
  const url = new URL(baseUrl, "http://localhost");
  url.searchParams.set("conversationId", conversationId);
  url.searchParams.set("offset", "0");

  const response = yield* call(() =>
    fetch(url.pathname + url.search, {
      method: "GET",
      headers: {
        Accept: "application/x-ndjson",
      },
    }),
  );

  if (response.status === 404) {
    return { patches: [], history: [] };
  }

  if (!response.ok) {
    throw new Error(`Failed to hydrate durable history: ${response.status}`);
  }

  const text = yield* call(() => response.text());
  const trimmed = text.trim();

  if (!trimmed) {
    return { patches: [], history: [] };
  }

  const frames = trimmed
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DurableFrame);

  return yield* replayFramesToConversation(frames, tools, transforms, onStreamEvent);
}
