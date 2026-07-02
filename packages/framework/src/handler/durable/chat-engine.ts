/**
 * Pull-Based Chat Engine
 *
 * A state machine that yields StreamEvent objects on demand.
 * Each call to next() advances the state machine and returns the next event.
 *
 * The engine handles:
 * - Session info emission
 * - Provider streaming (text, thinking, tool_calls)
 * - Tool execution with parallel execution and buffered results
 * - Tool loop iterations
 * - Elicitation detection and conversation state emission
 * - Error handling (non-fatal continues, fatal stops)
 *
 * @see ../docs/durable-chat-handler-plan.md for architecture details
 */
import { resource, type Operation, type Subscription } from "effection";
import type {
  AssistantMessage as RuntimeAssistantMessage,
  Context as RuntimeContext,
  Message as RuntimeMessage,
  StreamEvent as RuntimeStreamEvent,
} from "../../lib/chat/runtime/index.ts";
import type { StreamEvent, ChatMessage } from "../types.ts";
import type { AgUiRunMetadata } from "../../lib/chat/session/streaming.ts";
import type {
  ChatEngineParams,
  ChatEngine,
  ToolCall,
  ToolSchema,
  ToolExecutionResult,
} from "./types.ts";
import {
  type ToolExecution,
  type ToolExecutionEvent,
  type ToolExecutionRef,
} from "../../lib/chat/index.ts";
import {
  appendAssistantToolCallMessage,
  appendToolMessage,
  createTranscriptState,
} from "../../lib/chat/session/transcript.ts";
import { buildAgUiCustomState } from "../../lib/chat/session/ag-ui-checkpoint.ts";
import {
  activitySnapshotsForMessages,
  toProviderHistorySnapshot,
} from "../../lib/chat/session/ag-ui-projection.ts";
import {
  buildPluginReplayActivity,
  mergePluginReplayTrace,
  normalizeClientReplayTrace,
} from "../../lib/chat/session/plugin-replay.ts";
import { getToolParameterValidationErrorPayload } from "../../lib/chat/tool-parameters.ts";
import { randomUUID } from "node:crypto";

// =============================================================================
// INTERNAL STATE TYPES
// =============================================================================

interface EngineState {
  phase: string;
  iteration: number;
  conversationMessages: ChatMessage[];
  pendingEvents: StreamEvent[];
  runtimeSubscription: Subscription<RuntimeStreamEvent, RuntimeAssistantMessage> | null;
  runtimeResult: RuntimeAssistantMessage | null;
  toolCalls: ToolCall[] | null;
  toolResults: ToolExecutionResult[] | null;
  error: Error | null;
  awaitingElicitResult: ToolExecutionResult | null;
  assistantMessageId: string | null;
  assistantTextOpen: boolean;
  toolLifecycleEmitted: boolean;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert a runtime stream event to AG-UI StreamEvents.
 *
 * Text tokens are emitted incrementally as `TEXT_MESSAGE_CONTENT` events.
 * The first text token also triggers `TEXT_MESSAGE_START`.
 * Thinking tokens are projected as AG-UI reasoning message content.
 * Tool call lifecycle events are ignored here — durable tool lifecycle is emitted
 * after a supported final tool-use result is reconciled.
 */
function runtimeEventToAgUiStreamEvents(
  event: RuntimeStreamEvent,
  state: EngineState,
  agUiRun: { threadId: string; runId: string; parentRunId?: string },
): StreamEvent[] {
  switch (event.type) {
    case "text_delta": {
      const events: StreamEvent[] = [];
      if (!state.assistantTextOpen) {
        state.assistantMessageId ??= `assistant:final:${agUiRun.runId}`;
        state.assistantTextOpen = true;
        events.push({
          type: "TEXT_MESSAGE_START",
          messageId: state.assistantMessageId,
          role: "assistant" as const,
        });
      }
      events.push({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: state.assistantMessageId!,
        delta: event.delta,
      });
      return events;
    }
    case "thinking_delta":
      return [
        {
          type: "REASONING_MESSAGE_CONTENT",
          messageId: `reasoning:${agUiRun.runId}`,
          delta: event.delta,
        },
      ];
    case "error":
      return event.error.errorMessage
        ? [{ type: "RUN_ERROR", message: event.error.errorMessage, code: "runtime_error" }]
        : [];
    default:
      return [];
  }
}

/**
 * Convert a tool execution result to an AG-UI StreamEvent.
 *
 * - Success results emit `TOOL_CALL_RESULT`
 * - Error results emit a schema-valid `TOOL_CALL_RESULT` whose content starts with `Error:`
 * - Elicit results terminate the run through `RUN_FINISHED.outcome.type === "interrupt"`
 */
function toolResultToAgUiStreamEvent(
  result: ToolExecutionResult,
  agUiRun: AgUiRunMetadata,
): StreamEvent {
  if (!result.ok) {
    return {
      type: "TOOL_CALL_RESULT",
      messageId: `tool:${result.error.callId}`,
      toolCallId: result.error.callId,
      toolCallName: result.error.toolName,
      content: `Error: ${result.error.message}`,
      role: "tool",
      ...(result.error.validation ? { error: result.error.validation } : {}),
    };
  }

  if (result.kind === "plugin_awaiting") {
    return {
      type: "RUN_FINISHED",
      threadId: agUiRun.threadId,
      runId: agUiRun.runId,
      outcome: {
        type: "interrupt",
        interrupts: [
          {
            id: result.elicitRequest.elicitId,
            reason: "input_required",
            message: result.elicitRequest.message,
            toolCallId: result.callId,
            responseSchema: result.elicitRequest.schema,
            metadata: {
              "sweatpants/sessionId": result.sessionId,
              "sweatpants/toolName": result.toolName,
              "sweatpants/key": result.elicitRequest.key,
              "sweatpants/componentMode": "plugin-render",
            },
          },
        ],
      },
    };
  }

  const content =
    typeof result.serverOutput === "string"
      ? result.serverOutput
      : JSON.stringify(result.serverOutput);

  return {
    type: "TOOL_CALL_RESULT",
    messageId: `tool:${result.callId}`,
    toolCallId: result.callId,
    toolCallName: result.toolName,
    content,
    role: "tool",
  };
}

function validationErrorResult(error: unknown, call: ToolCall): ToolExecutionResult {
  const validation = getToolParameterValidationErrorPayload(error);
  const message = validation?.message ?? (error instanceof Error ? error.message : String(error));
  return {
    ok: false,
    error: {
      callId: validation?.callId ?? call.id,
      toolName: validation?.toolName ?? call.function.name,
      message,
      ...(validation ? { code: validation.code, issues: validation.issues, validation } : {}),
    },
  };
}

function toolExecutionToResult(execution: ToolExecution, call: ToolCall): ToolExecutionResult {
  const ref = execution.ref;
  const toolName = ref.toolName || call.function.name;

  switch (execution.kind) {
    case "completed":
      return {
        ok: true,
        kind: "result",
        callId: ref.callId,
        toolName,
        serverOutput: execution.result,
      };
    case "failed": {
      const validation = getToolParameterValidationErrorPayload(execution.error.cause);
      return {
        ok: false,
        error: {
          callId: validation?.callId ?? ref.callId,
          toolName: validation?.toolName ?? toolName,
          message: validation?.message ?? execution.error.message,
          ...(execution.error.code ? { code: execution.error.code } : {}),
          ...(validation ? { code: validation.code, issues: validation.issues, validation } : {}),
        },
      };
    }
    case "awaiting_elicit":
      return {
        ok: true,
        kind: "plugin_awaiting",
        callId: ref.callId,
        toolName,
        sessionId: ref.sessionId ?? ref.executionId,
        elicitRequest: {
          sessionId: ref.sessionId ?? ref.executionId,
          callId: ref.callId,
          toolName,
          elicitId: execution.request.elicitId,
          key: execution.request.key,
          message: execution.request.message,
          schema: execution.request.schema,
        },
      };
    case "running":
      return {
        ok: true,
        kind: "plugin_awaiting",
        callId: ref.callId,
        toolName,
        sessionId: ref.sessionId ?? ref.executionId,
        elicitRequest: {
          sessionId: ref.sessionId ?? ref.executionId,
          callId: ref.callId,
          toolName,
          elicitId: "running",
          key: "running",
          message: "Tool execution is still running.",
          schema: { type: "object", properties: {}, required: [] },
        },
      };
    default:
      return {
        ok: false,
        error: {
          callId: ref.callId,
          toolName,
          message: `Unsupported tool execution state: ${(execution as { kind?: string }).kind ?? "unknown"}`,
        },
      };
  }
}

function toolExecutionEventToExecution(
  ref: ToolExecutionRef,
  event: ToolExecutionEvent,
): ToolExecution {
  switch (event.type) {
    case "elicit_request":
      return {
        kind: "awaiting_elicit",
        ref,
        request: {
          elicitId: event.elicitId,
          key: event.key,
          message: event.message,
          schema: event.schema,
        },
      };
    case "result":
      return { kind: "completed", ref, result: event.result };
    case "error":
      return {
        kind: "failed",
        ref,
        error: { ...(event.code ? { code: event.code } : {}), message: event.message },
      };
    case "cancelled":
      return {
        kind: "failed",
        ref,
        error: { code: "TOOL_CANCELLED", message: event.reason ?? "Tool execution was cancelled" },
      };
    default:
      return { kind: "running", ref, events: undefined as never };
  }
}

function* settleRunningExecution(execution: ToolExecution): Operation<ToolExecution> {
  if (execution.kind !== "running") return execution;
  const subscription = yield* execution.events;
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      return {
        kind: "failed",
        ref: execution.ref,
        error: { code: "SESSION_ENDED", message: "Tool execution stream ended unexpectedly" },
      };
    }
    const settled = toolExecutionEventToExecution(execution.ref, next.value);
    if (settled.kind !== "running") return settled;
  }
}

function findToolNameForCall(messages: ChatMessage[], callId: string): string | undefined {
  for (const message of [...messages].reverse()) {
    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.id === callId) return toolCall.function.name;
    }
  }
  return undefined;
}

function validateContinuationRef(input: {
  ref: ToolExecutionRef | undefined;
  runtimeId: string;
  executionId: string;
  sessionId: string;
  callId: string;
  toolName: string;
}): void {
  const { ref, runtimeId, executionId, sessionId, callId, toolName } = input;
  if (!ref) return;
  if (ref.runtimeId !== runtimeId)
    throw new Error(
      `Continuation ref mismatch: runtimeId expected ${runtimeId}, received ${ref.runtimeId}`,
    );
  if (ref.executionId !== executionId)
    throw new Error(
      `Continuation ref mismatch: executionId expected ${executionId}, received ${ref.executionId}`,
    );
  if (ref.sessionId && ref.sessionId !== sessionId)
    throw new Error(
      `Continuation ref mismatch: sessionId expected ${sessionId}, received ${ref.sessionId}`,
    );
  if (ref.callId !== callId)
    throw new Error(`Continuation ref mismatch: callId expected ${callId}, received ${ref.callId}`);
  if (ref.toolName !== toolName)
    throw new Error(
      `Continuation ref mismatch: toolName expected ${toolName}, received ${ref.toolName}`,
    );
}

function agUiToolLifecycleEvents(toolCalls: ToolCall[]): StreamEvent[] {
  return toolCalls.flatMap((toolCall) => [
    {
      type: "TOOL_CALL_START" as const,
      toolCallId: toolCall.id,
      toolCallName: toolCall.function.name,
      parentMessageId: `assistant:tools:${toolCall.id}`,
    },
    {
      type: "TOOL_CALL_ARGS" as const,
      toolCallId: toolCall.id,
      delta: JSON.stringify(toolCall.function.arguments),
    },
    {
      type: "TOOL_CALL_END" as const,
      toolCallId: toolCall.id,
    },
  ]);
}

function agUiTextLifecycleEvents(
  messageId: string,
  role: "assistant" | "user" | "system",
  text: string,
): StreamEvent[] {
  return [
    {
      type: "TEXT_MESSAGE_START",
      messageId,
      role,
    },
    ...(text.length > 0
      ? [
          {
            type: "TEXT_MESSAGE_CONTENT" as const,
            messageId,
            delta: text,
          },
        ]
      : []),
    {
      type: "TEXT_MESSAGE_END",
      messageId,
    },
  ];
}

// =============================================================================
// CHAT ENGINE FACTORY
// =============================================================================

/**
 * Create a pull-based chat engine.
 *
 * The engine is a Stream that yields StreamEvent objects.
 * Each call to next() advances the internal state machine.
 *
 * @param params - Engine configuration
 * @returns A Stream of StreamEvent that can be pulled from
 */
export function createChatEngine(params: ChatEngineParams): ChatEngine {
  const {
    messages,
    replayState,
    systemPrompt,
    toolSchemas,
    runtime,
    model,
    streamOptions,
    initialToolChoice,
    toolInventoryEntries = [],
    toolRuntime,
    toolRuntimeId = toolRuntime?.id ?? "local",
    maxIterations,
    signal,
    sessionInfo,
    agUiRun,
    elicitResponses,
    pluginAbort,
  } = params;

  // Build schema lookup map
  const schemaByName = new Map<string, ToolSchema>();
  for (const schema of toolSchemas) {
    schemaByName.set(schema.name, schema);
  }

  const allSchemaMap = new Map<string, ToolSchema>();
  for (const schema of toolSchemas) {
    if (!allSchemaMap.has(schema.name)) allSchemaMap.set(schema.name, schema);
  }
  const allSchemas = Array.from(allSchemaMap.values());
  const inventoryByName = new Map(
    toolInventoryEntries.map((entry) => [entry.definition.name, entry] as const),
  );

  // Tool names set for filtering. Some providers approximate generated tool
  // names (for example, emitting `book-flight` or `book_flight` for
  // `book-flight_book_flight`). Keep the ordered list for unique alias
  // reconciliation before filtering unsupported calls.
  const toolNames = new Set(allSchemas.map((t) => t.name));
  const toolNameList = allSchemas.map((t) => t.name);

  return resource(function* (provide) {
    // Initialize state
    const state: EngineState = {
      phase: "init",
      iteration: 0,
      conversationMessages: [...messages],
      pendingEvents: [],
      runtimeSubscription: null,
      runtimeResult: null,
      toolCalls: null,
      toolResults: null,
      error: null,
      awaitingElicitResult: null,
      assistantMessageId: null,
      assistantTextOpen: false,
      toolLifecycleEmitted: false,
    };
    const conversationTranscriptState = createTranscriptState(state.conversationMessages);

    // Hidden/default prompts stay at the provider boundary and are not added
    // to client-visible conversation history.

    const replayToolTraceMap = new Map(
      (replayState?.toolTraces ?? []).map((trace) => [trace.callId, trace]),
    );

    function sanitizeToolCallIdPart(value: string): string {
      return value.replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
    }

    function collectUsedToolCallIds(): Set<string> {
      const ids = new Set<string>();

      for (const message of state.conversationMessages) {
        for (const toolCall of message.tool_calls ?? []) {
          const id = (toolCall as { id?: unknown }).id;
          if (typeof id === "string" && id.trim().length > 0) {
            ids.add(id);
          }
        }

        const toolCallId = (message as { tool_call_id?: unknown }).tool_call_id;
        if (typeof toolCallId === "string" && toolCallId.trim().length > 0) {
          ids.add(toolCallId);
        }
      }

      return ids;
    }

    const resolveProviderToolName = (name: string): string | undefined => {
      if (toolNames.has(name)) return name;

      const candidates = toolNameList.filter((candidate) => {
        if (candidate === name) return true;
        if (candidate.startsWith(`${name}_`)) return true;
        if (candidate.endsWith(`_${name}`)) return true;

        const splitAt = candidate.indexOf("_");
        if (splitAt <= 0) return false;
        const namespacePart = candidate.slice(0, splitAt);
        const intrinsicPart = candidate.slice(splitAt + 1);
        return name === namespacePart || name === intrinsicPart;
      });

      return candidates.length === 1 ? candidates[0] : undefined;
    };

    // Helper to convert provider tool calls to our format.
    // Some providers (notably Ollama-compatible APIs) can omit tool call IDs.
    // The rest of the chat/runtime stack keys plugin sessions, elicit state,
    // tool results, and UI parts by call ID, so synthesize a per-run ID when
    // the provider does not supply a usable unique one.
    const toRuntimeMessage = (message: ChatMessage): RuntimeMessage | null => {
      if (message.role === "system") {
        return { role: "system", content: message.content };
      }

      if (message.role === "user") {
        return { role: "user", content: message.content };
      }

      if (message.role === "tool") {
        return {
          role: "toolResult",
          toolCallId: message.tool_call_id ?? "",
          toolName: message.replay?.toolName ?? "",
          content: [{ type: "text", text: message.content }],
          isError: message.content.startsWith("Error:"),
        };
      }

      if (message.role !== "assistant") {
        return null;
      }

      const content: RuntimeAssistantMessage["content"] = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const toolCall of message.tool_calls ?? []) {
        content.push({
          type: "toolCall",
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
      }

      return { role: "assistant", content };
    };

    const buildRuntimeContext = (): RuntimeContext => ({
      ...(systemPrompt ? { systemPrompt } : {}),
      messages: state.conversationMessages
        .filter((message) => !(message.role === "system" && message.content === systemPrompt))
        .map(toRuntimeMessage)
        .filter((message): message is RuntimeMessage => message !== null),
      ...(allSchemas.length > 0
        ? {
            tools: allSchemas.map((schema) => ({
              name: schema.name,
              description: schema.description,
              parameters: schema.parameters,
            })),
          }
        : {}),
    });

    const runtimeText = (message: RuntimeAssistantMessage): string =>
      message.content
        .filter(
          (block): block is Extract<RuntimeAssistantMessage["content"][number], { type: "text" }> =>
            block.type === "text",
        )
        .map((block) => block.text)
        .join("");

    const runtimeToolCalls = (message: RuntimeAssistantMessage): ToolCall[] =>
      message.content
        .filter(
          (
            block,
          ): block is Extract<RuntimeAssistantMessage["content"][number], { type: "toolCall" }> =>
            block.type === "toolCall",
        )
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: {
            name: block.name,
            arguments: block.arguments,
          },
        }));

    const convertToolCalls = (calls: ToolCall[]): ToolCall[] => {
      if (calls.length === 0) return [];

      const usedIds = collectUsedToolCallIds();

      return calls.map((tc) => {
        const rawId = (tc as { id?: unknown }).id;
        let id = typeof rawId === "string" && rawId.trim().length > 0 ? rawId : "";

        if (!id || usedIds.has(id)) {
          const toolName = sanitizeToolCallIdPart(tc.function.name);
          do {
            id = `call:${randomUUID()}:${toolName}`;
          } while (usedIds.has(id));
        }

        usedIds.add(id);

        return {
          id,
          type: "function" as const,
          function: {
            name: resolveProviderToolName(tc.function.name) ?? tc.function.name,
            arguments: tc.function.arguments,
          },
        };
      });
    };

    // The subscription we provide to consumers
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        // Check abort signal - only set error if not already in done/error state
        if (signal.aborted && state.phase !== "done" && state.phase !== "error") {
          state.phase = "error";
          state.error = new Error("Aborted");
        }

        // Drain pending events first
        if (state.pendingEvents.length > 0) {
          return { done: false, value: state.pendingEvents.shift()! };
        }

        // State machine
        switch (state.phase) {
          case "init": {
            // Emit session info if provided
            if (sessionInfo) {
              // Determine next phase based on what needs processing
              if (pluginAbort) {
                state.phase = "process_plugin_abort";
              } else if (elicitResponses && elicitResponses.length > 0) {
                state.phase = "process_plugin_responses";
              } else {
                state.phase = "start_iteration";
              }
              return { done: false, value: sessionInfo };
            }
            // Same logic without session info
            if (pluginAbort) {
              state.phase = "process_plugin_abort";
            } else if (elicitResponses && elicitResponses.length > 0) {
              state.phase = "process_plugin_responses";
            } else {
              state.phase = "start_iteration";
            }
            return yield* this.next();
          }

          case "process_plugin_abort": {
            // Handle explicit abort request through the active ToolRuntime.
            if (pluginAbort) {
              const { sessionId, reason } = pluginAbort;
              const toolName = findToolNameForCall(state.conversationMessages, sessionId) ?? "";

              try {
                if (!toolRuntime)
                  throw new Error("Tool runtime not configured. Install a ToolRuntime in scope.");
                yield* toolRuntime.abort(
                  {
                    runtimeId: toolRuntimeId,
                    executionId: sessionId,
                    sessionId,
                    callId: sessionId,
                    toolName,
                  },
                  reason,
                );

                state.pendingEvents.push({
                  type: "tool_session_status",
                  sessionId,
                  callId: sessionId,
                  toolName,
                  status: "aborted",
                });
              } catch (_error) {
                state.pendingEvents.push({
                  type: "tool_session_error",
                  sessionId,
                  callId: sessionId,
                  error: "SESSION_NOT_FOUND",
                  message: `Tool execution ${sessionId} not found`,
                });
              }
            }

            // Move to next phase
            if (elicitResponses && elicitResponses.length > 0) {
              state.phase = "process_plugin_responses";
            } else {
              state.phase = "start_iteration";
            }

            // Return first pending event if any
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! };
            }
            return yield* this.next();
          }

          case "process_plugin_responses": {
            // Resume suspended tool executions with elicit responses through ToolRuntimeApi.
            if (elicitResponses) {
              for (const response of elicitResponses) {
                const { sessionId, callId, elicitId, result } = response;
                const toolName =
                  findToolNameForCall(state.conversationMessages, callId) ??
                  response.toolName ??
                  response.ref?.toolName ??
                  "";

                let elicitResult:
                  | { action: "accept"; content: unknown }
                  | { action: "decline" }
                  | { action: "cancel" };
                if (result.action === "accept") {
                  elicitResult = { action: "accept", content: result.content };
                } else if (result.action === "decline") {
                  elicitResult = { action: "decline" };
                } else {
                  elicitResult = { action: "cancel" };
                }

                if (response.trace && toolName) {
                  const normalizedTrace = normalizeClientReplayTrace(response.trace, {
                    interruptId: elicitId,
                  });
                  if (normalizedTrace) {
                    const existingReplayTrace = replayToolTraceMap.get(callId)?.trace;
                    const mergedTrace = mergePluginReplayTrace(existingReplayTrace, {
                      threadId: agUiRun.threadId,
                      runId: agUiRun.runId,
                      toolCallId: callId,
                      toolName,
                      interruptId: elicitId,
                      trace: normalizedTrace,
                    });
                    replayToolTraceMap.set(callId, {
                      callId,
                      toolName,
                      trace: mergedTrace,
                    });
                    const activity = buildPluginReplayActivity({
                      toolCallId: callId,
                      toolName,
                      trace: mergedTrace,
                    });
                    if (activity) state.pendingEvents.push(activity);
                  }
                }

                try {
                  if (!toolRuntime)
                    throw new Error("Tool runtime not configured. Install a ToolRuntime in scope.");
                  if (response.toolName && toolName && response.toolName !== toolName) {
                    throw new Error(
                      `Continuation toolName mismatch: expected ${toolName}, received ${response.toolName}`,
                    );
                  }
                  validateContinuationRef({
                    ref: response.ref,
                    runtimeId: toolRuntimeId,
                    executionId: sessionId,
                    sessionId,
                    callId,
                    toolName,
                  });
                  const resumed = yield* settleRunningExecution(
                    yield* toolRuntime.resume({
                      ref: {
                        runtimeId: toolRuntimeId,
                        executionId: sessionId,
                        sessionId,
                        callId,
                        toolName,
                      },
                      input: {
                        type: "elicit_response",
                        elicitId,
                        result: elicitResult,
                      },
                      signal,
                    }),
                  );
                  const toolResult = toolExecutionToResult(resumed, {
                    id: callId,
                    type: "function",
                    function: { name: toolName, arguments: {} },
                  });
                  if (toolResult.ok && toolResult.kind === "result") {
                    const replayTrace = replayToolTraceMap.get(callId)?.trace;
                    if (replayTrace) {
                      toolResult.trace = replayTrace;
                    }
                  }

                  if (toolResult.ok && toolResult.kind === "plugin_awaiting") {
                    state.pendingEvents.push(toolResultToAgUiStreamEvent(toolResult, agUiRun));
                    state.awaitingElicitResult = toolResult;
                    continue;
                  }

                  state.pendingEvents.push(toolResultToAgUiStreamEvent(toolResult, agUiRun));
                  if (toolResult.ok && toolResult.kind === "result") {
                    const content =
                      typeof toolResult.serverOutput === "string"
                        ? toolResult.serverOutput
                        : JSON.stringify(toolResult.serverOutput);
                    appendToolMessage(
                      state.conversationMessages,
                      conversationTranscriptState,
                      callId,
                      content,
                      { toolName },
                    );
                  } else if (!toolResult.ok) {
                    appendToolMessage(
                      state.conversationMessages,
                      conversationTranscriptState,
                      callId,
                      `Error: ${toolResult.error.message}`,
                      { toolName },
                    );
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  state.pendingEvents.push({
                    type: "tool_session_error",
                    sessionId,
                    callId,
                    error: "SESSION_NOT_FOUND",
                    message,
                  });
                  appendToolMessage(
                    state.conversationMessages,
                    conversationTranscriptState,
                    callId,
                    `Error: ${message}`,
                    { toolName },
                  );
                }
              }
            }

            // A resumed tool may request another interrupt. RUN_FINISHED with
            // interrupt outcome is terminal for this public AG-UI run, so do not
            // emit checkpoint/control events after it.
            if (state.awaitingElicitResult) {
              state.phase = "done";
            } else {
              state.phase = "start_iteration";
            }

            // Return first pending event if any
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! };
            }
            return yield* this.next();
          }

          case "start_iteration": {
            state.iteration++;

            if (state.iteration > maxIterations) {
              state.phase = "error";
              state.error = new Error("Max tool iterations reached");
              return yield* this.next();
            }

            // Start streaming from runtime. initialToolChoice applies only to
            // the first provider call for a new request; subsequent calls after
            // tool results use the normal stream options so the model can finish
            // with prose instead of being forced into another tool call.
            const runtimeStreamOptions = {
              ...streamOptions,
              ...(state.iteration === 1 && initialToolChoice
                ? { toolChoice: initialToolChoice }
                : {}),
              signal,
            };
            const runtimeStream = runtime.stream(
              model,
              buildRuntimeContext(),
              runtimeStreamOptions,
            );
            state.runtimeSubscription = yield* runtimeStream;
            state.phase = "streaming_provider";
            return yield* this.next();
          }

          case "streaming_provider": {
            if (!state.runtimeSubscription) {
              state.phase = "error";
              state.error = new Error("No runtime subscription");
              return yield* this.next();
            }

            const result = yield* state.runtimeSubscription.next();

            if (result.done) {
              state.runtimeResult = result.value;
              state.phase = "provider_complete";
              return yield* this.next();
            }

            if (result.value.type === "error") {
              if (state.assistantTextOpen) {
                state.pendingEvents.push({
                  type: "TEXT_MESSAGE_END",
                  messageId: state.assistantMessageId!,
                });
                state.assistantTextOpen = false;
              }
              state.pendingEvents.push(
                ...runtimeEventToAgUiStreamEvents(result.value, state, agUiRun),
              );
              state.phase = "done";
              if (state.pendingEvents.length > 0) {
                return { done: false, value: state.pendingEvents.shift()! };
              }
              return { done: true, value: undefined };
            }

            // Convert runtime event to AG-UI stream events
            const streamEvents = runtimeEventToAgUiStreamEvents(result.value, state, agUiRun);
            if (streamEvents.length > 0) {
              // Queue all events except the first, return the first immediately
              for (let i = 1; i < streamEvents.length; i++) {
                state.pendingEvents.push(streamEvents[i]!);
              }
              return { done: false, value: streamEvents[0]! };
            }

            // Unknown event type, continue
            return yield* this.next();
          }

          case "provider_complete": {
            const result = state.runtimeResult;
            if (!result) {
              state.phase = "error";
              state.error = new Error("No provider result");
              return yield* this.next();
            }

            if (result.stopReason === "error" || result.stopReason === "aborted") {
              if (state.assistantTextOpen) {
                state.pendingEvents.push({
                  type: "TEXT_MESSAGE_END",
                  messageId: state.assistantMessageId!,
                });
                state.assistantTextOpen = false;
              }
              state.pendingEvents.push({
                type: "RUN_ERROR",
                message: result.errorMessage ?? `Runtime generation ${result.stopReason}`,
                code: "runtime_error",
              });
              state.phase = "done";
              return { done: false, value: state.pendingEvents.shift()! };
            }

            const finalToolCalls = runtimeToolCalls(result);
            if (finalToolCalls.length > 0) {
              // Close the assistant text lifecycle if it was opened during streaming
              if (state.assistantTextOpen) {
                state.pendingEvents.push({
                  type: "TEXT_MESSAGE_END",
                  messageId: state.assistantMessageId!,
                });
                state.assistantTextOpen = false;
              }
              // Convert and filter to known tools. Some real providers can emit
              // malformed or unsupported tool calls. If none reconcile to a
              // supported tool, fall through to the normal no-tool completion
              // path so the run lifecycle still finishes cleanly.
              const allCalls = convertToolCalls(finalToolCalls);
              state.toolCalls = allCalls.filter((tc) => toolNames.has(tc.function.name));
              if (state.toolCalls.length > 0) {
                state.toolResults = [];
                state.phase = "executing_tools";
                return yield* this.next();
              }
            }

            // No supported tool calls - complete
            state.phase = "complete";

            if (state.assistantTextOpen) {
              // Text was streamed incrementally — just close the lifecycle
              state.pendingEvents.push({
                type: "TEXT_MESSAGE_END",
                messageId: state.assistantMessageId!,
              });
              state.assistantTextOpen = false;
            } else {
              // No text was streamed (edge case: empty response or provider gave no text events)
              // Emit the full text lifecycle as a batch
              state.pendingEvents.push(
                ...agUiTextLifecycleEvents(
                  `assistant:final:${agUiRun.runId}`,
                  "assistant",
                  runtimeText(result),
                ),
              );
            }

            state.pendingEvents.push({
              type: "RUN_FINISHED",
              threadId: agUiRun.threadId,
              runId: agUiRun.runId,
              outcome: { type: "success" },
            });
            return { done: false, value: state.pendingEvents.shift()! };
          }

          case "executing_tools": {
            const toolCalls = state.toolCalls || [];
            const results: ToolExecutionResult[] = [];

            // Resolve every outer model tool call through ToolInventory and execute
            // it through the active ToolRuntime.
            for (const tc of toolCalls) {
              try {
                const entry = inventoryByName.get(tc.function.name);
                if (!entry) throw new Error(`Tool not found: ${tc.function.name}`);
                if (!toolRuntime)
                  throw new Error("Tool runtime not configured. Install a ToolRuntime in scope.");
                const execution = yield* settleRunningExecution(
                  yield* toolRuntime.execute({
                    entry,
                    call: tc,
                    signal,
                    metadata: {
                      model: { provider: model.provider, id: model.id },
                    },
                  }),
                );
                const result = toolExecutionToResult(execution, tc);
                results.push(result);
              } catch (error) {
                const result = validationErrorResult(error, tc);
                results.push(result);
              }
            }

            state.toolResults = results;
            state.phase = "tools_complete";

            // Return first pending event
            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! };
            }
            return yield* this.next();
          }

          case "tools_complete": {
            const toolCalls = state.toolCalls || [];
            const results = state.toolResults || [];
            const providerResult = state.runtimeResult!;

            // Check for plugin tools awaiting elicitation
            const pluginAwaitingResults = results.filter(
              (r) => r.ok && r.kind === "plugin_awaiting",
            );

            if (pluginAwaitingResults.length > 0) {
              // CRITICAL: Add assistant message with tool_calls to conversationMessages
              // BEFORE going to awaiting_elicit. This ensures the conversation
              // state includes the tool call that's awaiting elicitation, so when the
              // client syncs and sends the next request, the LLM sees the proper
              // tool_call -> tool_result sequence. Without this, multi-turn elicit
              // conversations (like tictactoe) fail with "No tool call found" errors.
              appendAssistantToolCallMessage(
                state.conversationMessages,
                conversationTranscriptState,
                toolCalls,
                runtimeText(providerResult),
              );
              state.pendingEvents.push(...agUiToolLifecycleEvents(toolCalls));

              state.pendingEvents.push({
                type: "MESSAGES_SNAPSHOT",
                messages: toProviderHistorySnapshot(state.conversationMessages, {
                  toolTraces: Array.from(replayToolTraceMap.values()),
                }),
              });
              state.pendingEvents.push(
                ...activitySnapshotsForMessages(state.conversationMessages, {
                  toolTraces: Array.from(replayToolTraceMap.values()),
                }),
              );
              state.pendingEvents.push({
                type: "STATE_SNAPSHOT",
                snapshot: buildAgUiCustomState({}),
              });

              for (const r of pluginAwaitingResults) {
                if (r.ok && r.kind === "plugin_awaiting") {
                  state.awaitingElicitResult = r;
                }
              }
              state.pendingEvents.push({
                type: "RUN_FINISHED",
                threadId: agUiRun.threadId,
                runId: agUiRun.runId,
                outcome: {
                  type: "interrupt",
                  interrupts: pluginAwaitingResults.map((r) => ({
                    id: r.elicitRequest.elicitId,
                    reason: "input_required",
                    message: r.elicitRequest.message,
                    toolCallId: r.callId,
                    responseSchema: r.elicitRequest.schema,
                    metadata: {
                      "sweatpants/sessionId": r.sessionId,
                      "sweatpants/toolName": r.toolName,
                      "sweatpants/key": r.elicitRequest.key,
                      "sweatpants/componentMode": "plugin-render",
                    },
                  })),
                },
              });
              state.phase = "done";

              // Return first pending event
              if (state.pendingEvents.length > 0) {
                return { done: false, value: state.pendingEvents.shift()! };
              }
              return yield* this.next();
            }

            // Update messages and continue loop
            // Add assistant message with tool calls
            appendAssistantToolCallMessage(
              state.conversationMessages,
              conversationTranscriptState,
              toolCalls,
              runtimeText(providerResult),
            );
            state.pendingEvents.push(...agUiToolLifecycleEvents(toolCalls));
            for (const r of results) {
              state.pendingEvents.push(toolResultToAgUiStreamEvent(r, agUiRun));
            }

            // Add tool result messages
            for (const r of results) {
              if (r.ok && r.kind === "result") {
                appendToolMessage(
                  state.conversationMessages,
                  conversationTranscriptState,
                  r.callId,
                  typeof r.serverOutput === "string"
                    ? r.serverOutput
                    : JSON.stringify(r.serverOutput),
                  { toolName: r.toolName },
                );
              } else if (!r.ok) {
                appendToolMessage(
                  state.conversationMessages,
                  conversationTranscriptState,
                  r.error.callId,
                  `Error: ${r.error.message}`,
                  { toolName: r.error.toolName },
                );
              }
            }

            // Reset for next iteration
            state.toolCalls = null;
            state.toolResults = null;
            state.runtimeResult = null;
            state.runtimeSubscription = null;
            state.phase = "start_iteration";

            return yield* this.next();
          }

          case "awaiting_elicit": {
            const awaiting =
              state.awaitingElicitResult?.ok &&
              state.awaitingElicitResult.kind === "plugin_awaiting"
                ? state.awaitingElicitResult
                : null;

            state.pendingEvents.push({
              type: "MESSAGES_SNAPSHOT",
              messages: toProviderHistorySnapshot(state.conversationMessages, {
                toolTraces: Array.from(replayToolTraceMap.values()),
              }),
            });
            state.pendingEvents.push(
              ...activitySnapshotsForMessages(state.conversationMessages, {
                toolTraces: Array.from(replayToolTraceMap.values()),
              }),
            );
            state.pendingEvents.push({
              type: "STATE_SNAPSHOT",
              snapshot: buildAgUiCustomState({}),
            });
            if (awaiting) {
              state.pendingEvents.push(toolResultToAgUiStreamEvent(awaiting, agUiRun));
            }

            state.phase = "done";

            if (state.pendingEvents.length > 0) {
              return { done: false, value: state.pendingEvents.shift()! };
            }
            return yield* this.next();
          }

          case "complete": {
            state.phase = "done";
            return { done: true, value: undefined };
          }

          case "error": {
            const errorEvent: StreamEvent = {
              type: "RUN_ERROR",
              message: state.error?.message ?? "Unknown error",
              code: "internal_error",
            };
            state.phase = "done";
            return { done: false, value: errorEvent };
          }

          case "done": {
            return { done: true, value: undefined };
          }

          default: {
            state.phase = "error";
            state.error = new Error(`Unknown phase: ${state.phase}`);
            return yield* this.next();
          }
        }
      },
    });
  });
}
