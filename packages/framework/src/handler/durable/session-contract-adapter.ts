import { resource, spawn, type Operation, type Stream } from "effection";
import {
  createInMemorySession,
  deriveLogState,
  spawnFoldDriver,
  waitToken,
  type AgentConfig,
  type AnswerPayload,
  type CapabilityResolver,
  type FoldSessionHost,
  type ModelProvider,
  type SampleWaitPayload,
  type WaitRecord,
} from "@sweatpants/session-contract";

import type {
  AssistantMessage,
  Context as RuntimeContext,
  Message as RuntimeMessage,
  StreamEvent as RuntimeStreamEvent,
  ToolCallBlock,
} from "../../lib/chat/runtime/index.ts";
import type { StreamEvent } from "../../lib/chat/session/streaming.ts";
import type { ElicitResponse, SessionContractChatEngineParams } from "./types.ts";
import type { ToolExecution } from "../../lib/chat/tool-runtime.ts";
import type { ToolInventoryEntry } from "../../lib/chat/tool-inventory.ts";
import type { PluginSessionEvent } from "./plugin-session-manager.ts";
import { getToolParameterValidationErrorPayload } from "../../lib/chat/tool-parameters.ts";
import { buildPluginReplayActivity } from "../../lib/chat/session/plugin-replay.ts";

/**
 * Session-contract-native chat engine adapter.
 *
 * This is the Phase 3 bridge: internally it runs the canonical fold driver;
 * externally it is still a bounded `Stream<StreamEvent, void>` so the durable
 * chat handler, replay layer, React client, and e2e `networkidle` behavior do
 * not change.
 */
export function createSessionContractChatEngine(
  params: SessionContractChatEngineParams,
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    // Identity law: fold log is keyed only by conversationId.
    // agUiRun.threadId is a wire alias of conversationId; agUiRun.runId is
    // ephemeral turn correlation and must never key durable fold state.
    // The local name "sessionId" here is the fold session id (= conversationId),
    // not the HTTP response-stream id (X-Session-Id).
    const sessionId = params.conversationId;

    // Shared buffer store is optional only for hermetic unit tests. Product
    // hosts install FoldSessionBufferStoreContext so multi-turn resume reopens
    // the same log instead of inventing a fresh one.
    const bufferStore = params.foldSessionBufferStore;
    const session = yield* createInMemorySession({
      sessionId,
      mode: "fold",
      ...(bufferStore ? { bufferStore } : {}),
    });

    const existing = yield* session.records();
    const isResume = (params.elicitResponses ?? []).length > 0;

    let cursor: number;
    if (existing.length === 0 && isResume) {
      // Resume-only/public-resume bootstrap: there is no persisted fold log,
      // but the request includes assistant tool calls plus elicit responses.
      // Seed a suspended call-batch state so the fold driver can answer the
      // elicit wait, reattach the pending call, and continue the turn.
      yield* bootstrapResumeSession(params, session);
      const afterBootstrap = yield* session.records();
      cursor = afterBootstrap.length;
    } else if (existing.length === 0) {
      // New session: seed checkpoint + message wait, then read from after seeds.
      yield* session.checkpoint("fold");
      yield* session.emitWait("message", {});
      const afterSeed = yield* session.records();
      cursor = afterSeed.length;
    } else {
      // Resuming: the fold session already has records from the previous
      // request(s). Read from after the existing records so only new events
      // (produced by the resume/continuation) are projected to the client.
      cursor = existing.length;
    }

    const model = createChatFoldModelProvider(params);
    const resolver = createChatFoldCapabilityResolver(params);
    const config: AgentConfig = {
      name: "durable-chat",
      capabilities: Object.fromEntries(
        params.toolSchemas.map((tool) => [
          tool.name,
          {
            description: tool.description,
            input: tool.parameters,
          },
        ]),
      ),
      model,
      resolver,
      ...(params.systemPrompt !== undefined ? { system: params.systemPrompt } : {}),
      maxIterations: params.maxIterations,
    };

    if (isResume) {
      // Resume path: answer pending elicit waits from the request, then let the
      // fold driver own the rest of the lifecycle. It reattaches the pending
      // call, records the tool result (or re-elicit), and continues the turn
      // through the real model.
      //
      // Cancel/decline resumes may also carry a free-form user message (the
      // client supersedes an open interrupt with a new chat turn). Deliver that
      // message after resolving the interrupt so chat is not blocked.
      yield* spawn(function* () {
        try {
          const handled = yield* answerPendingElicits(params, session);
          if (!handled) {
            yield* session.terminal("error", {
              ok: false,
              code: "resume_unavailable",
              message: "Resume could not be routed to any live execution (no matching pending elicit)",
            });
            return;
          }

          // Free-form send superseding open elicits: close parked call waits as
          // cancelled instead of reattaching the tool (which would re-elicit).
          // Also close the abandoned mid-turn with a transcript checkpoint +
          // message wait so the fold driver does not re-run the previous user
          // message (decideAction treats fully-matched message waits as runnable).
          const freeFormAfterCancel = shouldDeliverUserMessageAfterResume(params);
          if (freeFormAfterCancel) {
            yield* abandonParkedTurnForFreeFormSend(session);
            const userMessage = latestUserMessage(params);
            yield* session.send(userMessage, {
              idempotencyKey: messageIdempotencyKey(sessionId, userMessage),
            });
          }

          yield* spawnFoldDriver(session, config);
        } catch (error) {
          // On scope close (halt), do NOT terminal the session — the fold
          // session persists in the shared buffer store and must stay open
          // for the next HTTP request. Only terminal on genuine errors.
          if (!isHaltError(error)) {
            try {
              yield* session.terminal("error", {
                ok: false,
                code: "runtime_error",
                message: error instanceof Error ? error.message : String(error),
              });
            } catch {
              // Session may already be terminal/cancelled.
            }
          }
        }
      });
    } else {
      yield* spawn(function* () {
        try {
          yield* spawnFoldDriver(session, config);
        } catch (error) {
          if (!isHaltError(error)) {
            try {
              yield* session.terminal("error", {
                ok: false,
                code: "runtime_error",
                message: error instanceof Error ? error.message : String(error),
              });
            } catch {
              // Session may already be terminal/cancelled.
            }
          }
        }
      });

      const userMessage = latestUserMessage(params);
      yield* session.send(userMessage, {
        idempotencyKey: messageIdempotencyKey(sessionId, userMessage),
      });
    }

    const records = yield* session.events(cursor);
    const queue: StreamEvent[] = [];
    let done = false;
    let sawCheckpoint = false;
    let assistantTextOpen = false;
    let sawTurnActivity = false;

    function enqueue(event: StreamEvent): void {
      queue.push(event);
      sawTurnActivity = true;
    }

    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        while (queue.length > 0) {
          return { done: false, value: queue.shift()! };
        }
        if (done) {
          return { done: true, value: undefined };
        }

        while (queue.length === 0 && !done) {
          const next = yield* records.next();
          if (next.done) {
            if (!done) {
              if (assistantTextOpen) {
                enqueue({ type: "TEXT_MESSAGE_END", messageId: assistantMessageId(params) });
                assistantTextOpen = false;
              }
              enqueue({ type: "RUN_FINISHED", ...params.agUiRun, outcome: { type: "success" } });
              done = true;
            }
            break;
          }

          const record = next.value;
          switch (record.kind) {
            case "emission": {
              for (const event of eventsFromEmission(record.payload)) {
                if (event.type === "TEXT_MESSAGE_START") {
                  assistantTextOpen = true;
                }
                if (event.type === "TEXT_MESSAGE_END") {
                  assistantTextOpen = false;
                }
                enqueue(event);
              }
              break;
            }
            case "answer": {
              if (record.wait === "call") {
                const event = toolResultEventFromCallAnswer(record.payload);
                if (event) {
                  enqueue(event);
                }
              }
              break;
            }
            case "wait": {
              if (record.wait === "elicit") {
                if (assistantTextOpen) {
                  enqueue({ type: "TEXT_MESSAGE_END", messageId: assistantMessageId(params) });
                  assistantTextOpen = false;
                }
                enqueue(elicitRunFinished(params, record as WaitRecord<"elicit">));
                done = true;
              } else if (record.wait === "message" && sawCheckpoint && sawTurnActivity) {
                if (assistantTextOpen) {
                  enqueue({ type: "TEXT_MESSAGE_END", messageId: assistantMessageId(params) });
                  assistantTextOpen = false;
                }
                enqueue({ type: "RUN_FINISHED", ...params.agUiRun, outcome: { type: "success" } });
                done = true;
              }
              break;
            }
            case "checkpoint": {
              sawCheckpoint = true;
              break;
            }
            case "terminal": {
              if (record.outcome === "error") {
                enqueue({
                  type: "RUN_ERROR",
                  message: terminalMessage(record.payload),
                  ...(terminalCode(record.payload) ? { code: terminalCode(record.payload)! } : {}),
                });
              } else if (record.outcome === "cancelled") {
                enqueue({ type: "RUN_ERROR", message: "Run cancelled", code: "RUN_ABORTED" });
              } else {
                enqueue({ type: "RUN_FINISHED", ...params.agUiRun, outcome: { type: "success" } });
              }
              done = true;
              break;
            }
            case "fate":
              break;
          }
        }

        if (queue.length > 0) {
          return { done: false, value: queue.shift()! };
        }
        return { done: true, value: undefined };
      },
    });
  });
}

function createChatFoldModelProvider(params: SessionContractChatEngineParams): ModelProvider {
  return {
    *sampleWithSession(
      request: SampleWaitPayload,
      { session }: { session: FoldSessionHost },
    ): Operation<AnswerPayload> {
      const runtimeContext = toRuntimeContext(request, params);
      let subscription;
      try {
        const stream = params.runtime.stream(params.model, runtimeContext, {
          ...params.streamOptions,
          signal: params.signal,
          ...(params.initialToolChoice && runtimeContext.messages.length === 1
            ? { toolChoice: params.initialToolChoice }
            : {}),
        });
        subscription = yield* stream;
      } catch (error) {
        return {
          ok: false,
          code: "runtime_error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const toolCalls: ToolCallBlock[] = [];
      let text = "";
      let textStarted = false;

      while (true) {
        const next = yield* subscription.next();
        if (next.done) {
          const final = next.value;
          const finalText = text || textFromAssistant(final);
          for (const block of final.content) {
            if (block.type !== "toolCall") {
              continue;
            }
            const canonical = canonicalToolCall(block, params);
            if (!canonical) {
              continue;
            }
            if (toolCalls.some((call) => call.id === canonical.id)) {
              continue;
            }
            toolCalls.push(canonical);
          }
          if (toolCalls.length > 0) {
            if (textStarted) {
              yield* session.emitEmission({
                protocol: "ag-ui",
                event: { type: "TEXT_MESSAGE_END", messageId: assistantMessageId(params) },
              });
            }
            return {
              ok: true,
              value: {
                calls: toolCalls.map((call) => ({
                  id: call.id,
                  target: call.name,
                  input: call.arguments,
                })),
                assistantText: finalText,
              },
            };
          }
          if (textStarted) {
            yield* session.emitEmission({
              protocol: "ag-ui",
              event: { type: "TEXT_MESSAGE_END", messageId: assistantMessageId(params) },
            });
          }
          return { ok: true, value: finalText };
        }

        const event = next.value;
        for (const projected of runtimeEventToStreamEvents(event, params, { textStarted })) {
          if (projected.type === "TEXT_MESSAGE_START") {
            textStarted = true;
          }
          yield* session.emitEmission({ protocol: "ag-ui", event: projected });
        }
        if (event.type === "text_delta") {
          text += event.delta;
        }
        if (event.type === "toolcall_end") {
          const canonical = canonicalToolCall(event.toolCall, params);
          if (!canonical) {
            continue;
          }
          toolCalls.push(canonical);
          yield* session.emitEmission({ protocol: "ag-ui", event: toolCallStartEvent(canonical) });
          yield* session.emitEmission({ protocol: "ag-ui", event: toolCallArgsEvent(canonical) });
          yield* session.emitEmission({ protocol: "ag-ui", event: toolCallEndEvent(canonical) });
        }
      }
    },
    *sample() {
      return {
        ok: false,
        code: "unsupported_operation",
        message: "chat fold model requires session context",
      };
    },
  } as ModelProvider;
}

function createChatFoldCapabilityResolver(
  params: SessionContractChatEngineParams,
): CapabilityResolver {
  return {
    *callWithSession(
      target: string,
      input: unknown,
      context: { parent: FoldSessionHost; callWaitSeq: number; callId?: string },
    ): Operation<AnswerPayload> {
      return yield* executeToolCall(
        params,
        target,
        input,
        context.callId ?? `call:${target}`,
        context.parent,
      );
    },
    *call(target: string, input: unknown): Operation<AnswerPayload> {
      return yield* executeToolCall(params, target, input, `call:${target}`);
    },
    *reattachCall(
      _callWaitSeq: number,
      context: { session: FoldSessionHost; callId?: string },
    ): Operation<AnswerPayload | null> {
      return yield* reattachToolCall(params, context.session, context.callId);
    },
  } as CapabilityResolver;
}

function* executeToolCall(
  params: SessionContractChatEngineParams,
  target: string,
  input: unknown,
  callId: string,
  parent?: FoldSessionHost,
): Operation<AnswerPayload> {
  const entry = resolveToolEntry(params, target);
  if (!entry) {
    return {
      ok: true,
      value: { callId, toolName: target, result: `Error: Tool not found: ${target}` },
    };
  }
  const pluginTool = pluginToolImplementation(entry.implementation);
  if (pluginTool && params.pluginSessionManager) {
    return yield* executePluginToolCall(
      params,
      pluginTool,
      entry.definition.name,
      input,
      callId,
      parent,
    );
  }
  if (!params.toolRuntime) {
    return {
      ok: true,
      value: {
        callId,
        toolName: entry.definition.name,
        result: `Error: Tool runtime not configured for ${entry.definition.name}`,
      },
    };
  }
  try {
    const execution = yield* params.toolRuntime.execute({
      entry,
      call: {
        id: callId,
        type: "function",
        function: { name: entry.definition.name, arguments: asRecord(input) },
      },
      signal: params.signal,
      metadata: { threadId: params.agUiRun.threadId, runId: params.agUiRun.runId },
    });
    return yield* answerFromToolExecution(execution, entry.definition.name, parent);
  } catch (error) {
    const validation = getToolParameterValidationErrorPayload(error);
    const message = validation?.message ?? (error instanceof Error ? error.message : String(error));
    return {
      ok: true,
      value: {
        callId,
        toolName: entry.definition.name,
        result: `Error: ${message}`,
        ...(validation ? { error: validation } : {}),
      },
    };
  }
}

function* executePluginToolCall(
  params: SessionContractChatEngineParams,
  tool: unknown,
  toolName: string,
  input: unknown,
  callId: string,
  parent?: FoldSessionHost,
): Operation<AnswerPayload> {
  const session = yield* params.pluginSessionManager!.create({
    tool: tool as never,
    params: input,
    callId,
    signal: params.signal,
  });
  const event = yield* session.nextEvent();
  return yield* answerFromPluginSessionEvent(event, toolName, callId, parent);
}

function* answerFromPluginSessionEvent(
  event: PluginSessionEvent | null,
  toolName: string,
  callId: string,
  parent?: FoldSessionHost,
): Operation<AnswerPayload> {
  if (!event) {
    return { ok: false, code: "session_lost", message: "Plugin session ended without a result" };
  }
  switch (event.type) {
    case "elicit_request":
      if (parent) {
        yield* emitParentElicitWait(parent, toolName, callId, event.elicitId, {
          key: event.key,
          message: event.message,
          schema: event.schema,
          ref: {
            runtimeId: "plugin-session-manager",
            executionId: callId,
            sessionId: callId,
            callId,
            toolName,
          },
        });
      }
      return {
        ok: false,
        code: "tool_awaiting_elicit",
        message: event.message,
        details: { callId, toolName, elicitId: event.elicitId, key: event.key },
      };
    case "result":
      return { ok: true, value: { callId, toolName, result: event.result } };
    case "error":
      return { ok: false, code: "tool_error", message: event.message };
    case "cancelled":
      return {
        ok: false,
        code: "resume_unavailable",
        message: event.reason ?? "Plugin session cancelled",
      };
  }
}

function pluginToolImplementation(implementation: unknown): unknown | null {
  return implementation &&
    typeof implementation === "object" &&
    (implementation as { kind?: unknown }).kind === "mcp" &&
    "tool" in implementation
    ? (implementation as { tool: unknown }).tool
    : null;
}

function resolveToolEntry(
  params: SessionContractChatEngineParams,
  target: string,
): ToolInventoryEntry | undefined {
  const entries = params.toolInventoryEntries ?? [];
  const exact = entries.find((entry) => entry.definition.name === target);
  if (exact) {
    return exact;
  }
  const aliasMatches = entries.filter((entry) => entry.definition.name.startsWith(`${target}_`));
  return aliasMatches.length === 1 ? aliasMatches[0] : undefined;
}

function canonicalToolCall(
  toolCall: ToolCallBlock,
  params: SessionContractChatEngineParams,
): ToolCallBlock | null {
  const entry = resolveToolEntry(params, toolCall.name);
  if (!entry) {
    return null;
  }
  const name = entry.definition.name;
  // Some providers omit tool-call ids. The fold driver requires a stable string
  // id per call (it becomes the tool_call_id, the resolver callId, the plugin
  // session key, and the interrupt/resume ref). Synthesize a deterministic id
  // from the turn + call signature so the streaming and final-message passes
  // agree on the same id and downstream resume can address the call.
  const id =
    typeof toolCall.id === "string" && toolCall.id.length > 0
      ? toolCall.id
      : synthesizeToolCallId(params, name, toolCall.arguments);
  return { ...toolCall, id, name };
}

function synthesizeToolCallId(
  params: SessionContractChatEngineParams,
  name: string,
  args: unknown,
): string {
  const seed = `${name}:${stableStringify(args)}`;
  let hash = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  }
  return `${assistantMessageId(params)}-call-${hash.toString(36)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .slice()
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    );
  return `{${entries.join(",")}}`;
}

function* answerFromToolExecution(
  execution: ToolExecution,
  target: string,
  parent?: FoldSessionHost,
): Operation<AnswerPayload> {
  switch (execution.kind) {
    case "completed":
      return {
        ok: true,
        value: { callId: execution.ref.callId, toolName: target, result: execution.result },
      };
    case "failed": {
      const validation = getToolParameterValidationErrorPayload(execution.error.cause);
      return {
        ok: true,
        value: {
          callId: execution.ref.callId,
          toolName: target,
          result: `Error: ${execution.error.message}`,
          ...(validation ? { error: validation } : {}),
        },
      };
    }
    case "awaiting_elicit": {
      if (parent) {
        yield* emitParentElicitWait(
          parent,
          target,
          execution.ref.callId,
          execution.request.elicitId,
          {
            key: execution.request.key,
            message: execution.request.message,
            schema: execution.request.schema,
            ...(execution.request.context ? { context: execution.request.context } : {}),
            ref: execution.ref,
          },
        );
      }
      return {
        ok: false,
        code: "tool_awaiting_elicit",
        message: execution.request.message,
        details: { callId: execution.ref.callId, toolName: target, request: execution.request },
      };
    }
    case "running":
      return yield* answerFromRunningToolExecution(execution, target, parent);
  }
}

function* bootstrapResumeSession(
  params: SessionContractChatEngineParams,
  session: FoldSessionHost,
): Operation<void> {
  const responses = params.elicitResponses ?? [];
  if (responses.length === 0) {
    return;
  }

  const calls: Array<{ id: string; target: string; input: unknown }> = [];
  const seenCallIds = new Set<string>();
  for (const response of responses) {
    if (seenCallIds.has(response.callId)) {
      continue;
    }
    const call = findToolCallInMessages(params.messages, response.callId, response.toolName);
    if (!call) {
      continue;
    }
    calls.push(call);
    seenCallIds.add(call.id);
  }

  if (calls.length === 0) {
    return;
  }

  yield* session.checkpoint("fold", {
    kind: "call_batch",
    nextIteration: 1,
    transcript: foldTranscriptFromMessages(params.messages),
    calls,
  });

  for (const call of calls) {
    yield* session.emitWait("call", {
      target: call.target,
      input: call.input,
      callId: call.id,
    });
  }

  for (const response of responses) {
    if (!seenCallIds.has(response.callId)) {
      continue;
    }
    yield* session.emitWait("elicit", {
      key: response.toolName ?? "resume",
      message: `Resume ${response.toolName ?? "tool"}`,
      responseSchema: {},
      metadata: {
        ...(response.toolName ? { "sweatpants/toolName": response.toolName } : {}),
        callId: response.callId,
        elicitId: response.elicitId,
        ...(response.ref ? { ref: response.ref } : {}),
      },
    });
  }
}

function* answerPendingElicits(
  params: SessionContractChatEngineParams,
  session: FoldSessionHost,
): Operation<boolean> {
  const records = yield* session.records();
  const state = deriveLogState(session.id, records);
  let handled = false;

  for (const response of params.elicitResponses ?? []) {
    const pending = state.pendingWaits.find((wait) => {
      if (wait.kind !== "elicit") {
        return false;
      }
      const metadata = (wait.payload as { metadata?: Record<string, unknown> }).metadata;
      const waitElicitId = typeof metadata?.["elicitId"] === "string"
        ? metadata["elicitId"]
        : undefined;
      const waitCallId = typeof metadata?.["callId"] === "string"
        ? metadata["callId"]
        : undefined;
      return waitElicitId === response.elicitId && waitCallId === response.callId;
    });
    if (!pending) {
      continue;
    }

    const answered = yield* session.respondIfPending(
      waitToken(session.id, pending.waitSeq),
      { ok: true, value: response.result },
      { wait: "elicit" },
    );
    if (answered.type === "accepted") {
      const metadata = (pending.payload as { metadata?: Record<string, unknown> }).metadata;
      const toolName = response.toolName ??
        (typeof metadata?.["sweatpants/toolName"] === "string"
          ? metadata["sweatpants/toolName"]
          : "tool");
      const replayActivity = response.trace
        ? buildPluginReplayActivity({
            toolCallId: response.callId,
            toolName,
            trace: response.trace,
          })
        : null;
      if (replayActivity) {
        yield* session.emitEmission({ protocol: "ag-ui", event: replayActivity });
      }
      handled = true;
    }
  }

  return handled;
}

function* reattachToolCall(
  params: SessionContractChatEngineParams,
  session: FoldSessionHost,
  callId?: string,
): Operation<AnswerPayload | null> {
  const answered = yield* latestAnsweredElicitForCall(session, callId);
  if (!answered) {
    return null;
  }

  if (callId && params.pluginSessionManager) {
    const pluginSession = yield* params.pluginSessionManager.get(callId);
    if (pluginSession) {
      yield* pluginSession.respondToElicit(answered.elicitId, answered.result as never);
      const event = yield* pluginSession.nextEvent();
      return yield* answerFromPluginSessionEvent(
        event,
        answered.toolName ?? pluginSession.toolName,
        callId,
        session,
      );
    }
  }

  const ref = answered.ref;
  if (!ref || !params.toolRuntime) {
    return null;
  }
  if (params.toolRuntimeId && ref.runtimeId !== params.toolRuntimeId) {
    return {
      ok: false,
      code: "TOOL_RESUME_FAILED",
      message: `Continuation ref mismatch: runtimeId expected ${params.toolRuntimeId}, received ${ref.runtimeId}`,
    };
  }
  try {
    const execution = yield* params.toolRuntime.resume({
      ref,
      input: { type: "elicit_response", elicitId: answered.elicitId, result: answered.result },
      signal: params.signal,
      metadata: { threadId: params.agUiRun.threadId, runId: params.agUiRun.runId },
    });
    return yield* answerFromToolExecution(execution, ref.toolName, session);
  } catch (error) {
    return {
      ok: false,
      code: "TOOL_RESUME_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function* latestAnsweredElicitForCall(
  session: FoldSessionHost,
  callId?: string,
): Operation<{
  elicitId: string;
  result: ElicitResponse["result"];
  ref?: NonNullable<ElicitResponse["ref"]>;
  toolName?: string;
} | null> {
  const records = yield* session.records();
  const state = deriveLogState(session.id, records);

  for (const record of [...records].reverse()) {
    if (record.kind !== "wait" || record.wait !== "elicit") {
      continue;
    }
    const elicit = record as WaitRecord<"elicit">;
    const metadata = elicit.payload.metadata;
    const metadataCallId = typeof metadata?.["callId"] === "string"
      ? metadata["callId"]
      : undefined;
    if (callId && metadataCallId !== callId) {
      continue;
    }

    const answer = state.answers.get(elicit.waitSeq)?.payload as AnswerPayload | undefined;
    if (!answer?.ok) {
      continue;
    }

    const elicitId = typeof metadata?.["elicitId"] === "string"
      ? metadata["elicitId"]
      : String(elicit.payload.key || `wait:${elicit.waitSeq}`);
    const toolName = typeof metadata?.["sweatpants/toolName"] === "string"
      ? metadata["sweatpants/toolName"]
      : undefined;
    const ref = metadata?.["ref"] as NonNullable<ElicitResponse["ref"]> | undefined;
    return {
      elicitId,
      result: answer.value as ElicitResponse["result"],
      ...(ref ? { ref } : {}),
      ...(toolName ? { toolName } : {}),
    };
  }

  return null;
}

function foldTranscriptFromMessages(messages: SessionContractChatEngineParams["messages"]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    const record = message as unknown as Record<string, unknown>;
    const role = typeof record["role"] === "string" ? record["role"] : "user";
    const content = record["content"];
    if (role === "assistant") {
      const toolCalls = Array.isArray(record["tool_calls"])
        ? record["tool_calls"].map((call) => {
            const candidate = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
            return {
              id: typeof candidate.id === "string" ? candidate.id : "tool-call",
              type: "function" as const,
              function: {
                name: typeof candidate.function?.name === "string" ? candidate.function.name : "unknown",
                arguments: asRecord(candidate.function?.arguments),
              },
            };
          })
        : [];
      return {
        role,
        content: typeof content === "string" ? content : "",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    if (role === "tool") {
      return {
        role,
        tool_call_id: typeof record["tool_call_id"] === "string" ? record["tool_call_id"] : undefined,
        content: typeof content === "string" ? content : stringifyToolResult(content),
      };
    }
    return {
      role,
      content: typeof content === "string" ? content : stringifyToolResult(content),
    };
  });
}

function findToolCallInMessages(
  messages: SessionContractChatEngineParams["messages"],
  callId: string,
  toolName?: string,
): { id: string; target: string; input: unknown } | null {
  for (const message of [...messages].reverse()) {
    const record = message as unknown as Record<string, unknown>;
    const toolCalls = Array.isArray(record["tool_calls"]) ? record["tool_calls"] : [];
    for (const toolCall of toolCalls) {
      const candidate = toolCall as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const id = typeof candidate.id === "string" ? candidate.id : undefined;
      const name = typeof candidate.function?.name === "string" ? candidate.function.name : undefined;
      if (id === callId || (!id && toolName && name === toolName && toolCalls.length === 1)) {
        return {
          id: callId,
          target: name ?? toolName ?? "unknown",
          input: asRecord(candidate.function?.arguments),
        };
      }
    }
  }
  return toolName ? { id: callId, target: toolName, input: {} } : null;
}

function* emitParentElicitWait(
  parent: FoldSessionHost,
  toolName: string,
  callId: string,
  elicitId: string,
  request: {
    key: string;
    message: string;
    schema: Record<string, unknown>;
    context?: Record<string, unknown>;
    ref: unknown;
  },
): Operation<void> {
  yield* parent.emitWait("elicit", {
    key: request.key,
    message: request.message,
    responseSchema: withModelContext(request.schema, request.context),
    metadata: {
      "sweatpants/toolName": toolName,
      "sweatpants/key": request.key,
      callId,
      elicitId,
      ref: request.ref,
    },
  });
}

function* answerFromRunningToolExecution(
  execution: Extract<ToolExecution, { kind: "running" }>,
  target: string,
  parent?: FoldSessionHost,
): Operation<AnswerPayload> {
  const events = yield* execution.events;
  let next = yield* events.next();
  while (!next.done) {
    const event = next.value;
    switch (event.type) {
      case "elicit_request": {
        if (parent) {
          const context = asOptionalRecord(event["context"]);
          yield* emitParentElicitWait(parent, target, execution.ref.callId, event.elicitId, {
            key: event.key,
            message: event.message,
            schema: event.schema,
            ...(context ? { context } : {}),
            ref: execution.ref,
          });
        }
        return {
          ok: false,
          code: "tool_awaiting_elicit",
          message: event.message,
          details: {
            callId: execution.ref.callId,
            toolName: target,
            elicitId: event.elicitId,
            key: event.key,
          },
        };
      }
      case "result":
        return {
          ok: true,
          value: { callId: execution.ref.callId, toolName: target, result: event.result },
        };
      case "error":
        return { ok: false, code: event.code ?? "tool_error", message: event.message };
      case "cancelled":
        return {
          ok: false,
          code: "resume_unavailable",
          message: event.reason ?? "Tool execution cancelled",
        };
      default:
        break;
    }
    next = yield* events.next();
  }
  return { ok: false, code: "session_lost", message: "Tool execution ended without a result" };
}

function runtimeEventToStreamEvents(
  event: RuntimeStreamEvent,
  params: SessionContractChatEngineParams,
  state: { textStarted: boolean },
): StreamEvent[] {
  switch (event.type) {
    case "text_delta":
      return [
        ...(state.textStarted
          ? []
          : [
              {
                type: "TEXT_MESSAGE_START" as const,
                messageId: assistantMessageId(params),
                role: "assistant" as const,
              },
            ]),
        { type: "TEXT_MESSAGE_CONTENT", messageId: assistantMessageId(params), delta: event.delta },
      ];
    case "thinking_delta":
      return [
        {
          type: "REASONING_MESSAGE_CONTENT",
          messageId: `reasoning:${params.agUiRun.runId}`,
          delta: event.delta,
        },
      ];
    case "error":
      return [
        {
          type: "RUN_ERROR",
          message: event.error.errorMessage ?? "Runtime error",
          code: "runtime_error",
        },
      ];
    default:
      return [];
  }
}

function eventsFromEmission(payload: unknown): StreamEvent[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as { protocol?: unknown; event?: unknown; type?: unknown };
  if (record.protocol === "ag-ui" && record.event && typeof record.event === "object") {
    return [record.event as StreamEvent];
  }
  return [];
}

function toolResultEventFromCallAnswer(payload: AnswerPayload): StreamEvent | null {
  if (!payload.ok) {
    return null;
  }
  const value = payload.value as
    | { callId?: unknown; toolName?: unknown; result?: unknown; error?: unknown }
    | undefined;
  if (!value || typeof value.callId !== "string") {
    return null;
  }
  return {
    type: "TOOL_CALL_RESULT",
    messageId: `tool:${value.callId}`,
    toolCallId: value.callId,
    ...(typeof value.toolName === "string" ? { toolCallName: value.toolName } : {}),
    content: stringifyToolResult(value.result),
    role: "tool",
    ...(value.error && typeof value.error === "object" ? { error: value.error as never } : {}),
  };
}

function elicitRunFinished(
  params: SessionContractChatEngineParams,
  wait: WaitRecord<"elicit">,
): StreamEvent {
  return {
    type: "RUN_FINISHED",
    ...params.agUiRun,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id:
            metadataString(wait.payload.metadata, "elicitId") ??
            String(wait.payload.key || `wait:${wait.waitSeq}`),
          reason: "input_required",
          ...(metadataString(wait.payload.metadata, "callId")
            ? { toolCallId: metadataString(wait.payload.metadata, "callId")! }
            : {}),
          message: wait.payload.message,
          responseSchema: asRecord(wait.payload.responseSchema),
          ...(wait.expiresAt ? { expiresAt: wait.expiresAt } : {}),
          ...(publicInterruptMetadata(wait.payload.metadata)
            ? { metadata: publicInterruptMetadata(wait.payload.metadata)! }
            : {}),
        },
      ],
    },
  };
}

function isHaltError(error: unknown): boolean {
  return error instanceof Error && error.message === "halted";
}

function latestUserMessage(params: SessionContractChatEngineParams) {
  const last = [...params.messages].reverse().find((message) => message.role === "user");
  return {
    role: "user" as const,
    content: last?.content ?? "",
    ...(typeof last?.id === "string" && last.id.length > 0 ? { id: last.id } : {}),
  };
}

function messageIdempotencyKey(
  sessionId: string,
  message: { id?: string; content: string },
): string {
  // Prefer client message identity when present. Fall back to content hash so
  // free-form turns that only send the latest user message still get a stable
  // unique key across requests (messages.length is not durable identity).
  if (typeof message.id === "string" && message.id.length > 0) {
    return `chat:${sessionId}:message-id:${message.id}`;
  }
  return `chat:${sessionId}:message-content:${stableStringify(message.content)}`;
}

/**
 * When the client cancels/declines open elicits as part of a free-form send,
 * the request still carries a new user message that must be delivered after
 * the interrupt is closed. Pure accept resumes continue the parked tool turn
 * and should not inject a new user message.
 */
function shouldDeliverUserMessageAfterResume(
  params: SessionContractChatEngineParams,
): boolean {
  const responses = params.elicitResponses ?? [];
  if (responses.length === 0) return false;
  const allNonAccept = responses.every(
    (response) => response.result.action === "cancel" || response.result.action === "decline",
  );
  if (!allNonAccept) return false;
  const last = [...params.messages].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" && last.content.trim().length > 0;
}

function* abandonParkedTurnForFreeFormSend(session: FoldSessionHost): Operation<void> {
  const records = yield* session.records();
  const state = deriveLogState(session.id, records);

  for (const wait of state.pendingWaits) {
    if (wait.kind === "call") {
      yield* session.respondIfPending(
        waitToken(session.id, wait.waitSeq),
        {
          ok: false,
          code: "cancelled",
          message: "Tool call cancelled by user sending a new message",
        },
        { wait: "call" },
      );
    } else if (wait.kind === "sample") {
      yield* session.respondIfPending(
        waitToken(session.id, wait.waitSeq),
        {
          ok: false,
          code: "cancelled",
          message: "Sample cancelled by user sending a new message",
        },
        { wait: "sample" },
      );
    }
  }

  // Prefer the latest suspended call-batch transcript so history remains intact.
  const suspended = [...(yield* session.records())]
    .reverse()
    .find(
      (record) =>
        record.kind === "checkpoint" &&
        record.state &&
        typeof record.state === "object" &&
        (record.state as { kind?: unknown }).kind === "call_batch" &&
        Array.isArray((record.state as { transcript?: unknown }).transcript),
    );
  const transcript =
    suspended && suspended.kind === "checkpoint"
      ? ((suspended.state as { transcript: unknown[] }).transcript ?? [])
      : [];

  yield* session.checkpoint("fold", {
    kind: "transcript",
    transcript,
  });
  yield* session.emitWait("message", {});
}

function toRuntimeContext(
  request: SampleWaitPayload,
  params: SessionContractChatEngineParams,
): RuntimeContext {
  return {
    ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    messages: request.messages.map(toRuntimeMessage),
    tools: params.toolSchemas.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}

function toRuntimeMessage(message: unknown): RuntimeMessage {
  const record =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)
      : { role: "user", content: String(message ?? "") };
  const role = record["role"];
  if (role === "assistant") {
    const content = typeof record["content"] === "string" ? record["content"] : "";
    const toolCalls = Array.isArray(record["tool_calls"]) ? record["tool_calls"] : [];
    return {
      role: "assistant",
      content: [
        ...(content ? [{ type: "text" as const, text: content }] : []),
        ...toolCalls.map((call) => {
          const c = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
          return {
            type: "toolCall" as const,
            id: typeof c.id === "string" ? c.id : "tool-call",
            name: typeof c.function?.name === "string" ? c.function.name : "unknown",
            arguments: asRecord(c.function?.arguments),
          };
        }),
      ],
    };
  }
  if (role === "tool") {
    return {
      role: "toolResult",
      toolCallId: typeof record["tool_call_id"] === "string" ? record["tool_call_id"] : "tool-call",
      toolName: "tool",
      content: [
        {
          type: "text",
          text:
            typeof record["content"] === "string"
              ? record["content"]
              : stringifyToolResult(record["content"]),
        },
      ],
      isError: false,
    };
  }
  if (role === "system") {
    return {
      role: "system",
      content:
        typeof record["content"] === "string"
          ? record["content"]
          : stringifyToolResult(record["content"]),
    };
  }
  return {
    role: "user",
    content:
      typeof record["content"] === "string"
        ? record["content"]
        : stringifyToolResult(record["content"]),
  };
}

function textFromAssistant(message: AssistantMessage): string {
  return message.content
    .filter(
      (block): block is Extract<AssistantMessage["content"][number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function assistantMessageId(params: SessionContractChatEngineParams): string {
  return `assistant:final:${params.agUiRun.runId}`;
}

function toolCallStartEvent(toolCall: ToolCallBlock): StreamEvent {
  return {
    type: "TOOL_CALL_START",
    toolCallId: toolCall.id,
    toolCallName: toolCall.name,
    parentMessageId: `assistant:tools:${toolCall.id}`,
  };
}

function toolCallArgsEvent(toolCall: ToolCallBlock): StreamEvent {
  return {
    type: "TOOL_CALL_ARGS",
    toolCallId: toolCall.id,
    delta: JSON.stringify(toolCall.arguments),
  };
}

function toolCallEndEvent(toolCall: ToolCallBlock): StreamEvent {
  return { type: "TOOL_CALL_END", toolCallId: toolCall.id };
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function publicInterruptMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  for (const key of ["sweatpants/toolName", "sweatpants/key"]) {
    if (metadata[key] !== undefined) {
      result[key] = metadata[key];
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function withModelContext(
  schema: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return context ? { ...schema, "x-model-context": context } : schema;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringifyToolResult(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function terminalMessage(payload: unknown): string {
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as { message?: unknown }).message === "string"
  ) {
    return (payload as { message: string }).message;
  }
  return "Session failed";
}

function terminalCode(payload: unknown): string | undefined {
  return payload &&
    typeof payload === "object" &&
    typeof (payload as { code?: unknown }).code === "string"
    ? (payload as { code: string }).code
    : undefined;
}
