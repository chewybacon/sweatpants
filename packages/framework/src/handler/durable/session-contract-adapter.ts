import { createScope, resource, type Operation, type Stream } from "effection";
import {
  all,
  createCrankRuntime,
  createCrankSession,
  createInMemoryCrankStore,
  effect,
  elicit,
  emit,
  projectRecord,
  type EffectContext,
  type JournalRecord,
  type Json,
  type ProgramFactory,
  type PublicEvent,
} from "@sweatpants/session-contract";

import type {
  AssistantMessage,
  ContentBlock,
  Context as RuntimeContext,
  Message as RuntimeMessage,
  ToolCallBlock,
} from "../../lib/chat/runtime/index.ts";
import type { StreamEvent } from "../../lib/chat/session/streaming.ts";
import { internalMessageToAgUiMessage } from "../../lib/chat/session/ag-ui-compat.ts";
import type { SessionContractChatEngineParams } from "./types.ts";
import type { PluginSessionEvent } from "./plugin-session-manager.ts";
import type { ToolExecution } from "../../lib/chat/tool-runtime.ts";
import { getToolParameterValidationErrorPayload } from "../../lib/chat/tool-parameters.ts";

const defaultCrankStore = createInMemoryCrankStore();

function startDetachedActivation(
  runtime: ReturnType<typeof createCrankRuntime>,
  sessionId: string,
): void {
  const [scope, destroy] = createScope();
  const task = scope.run(function* () {
    yield* runtime.activate(sessionId);
  });
  void task.then(
    () => destroy(),
    () => destroy(),
  );
}

/**
 * Compatibility transport over the replay-crank public event stream. Private
 * journal records are never interpreted as AG-UI frames.
 */
export function createSessionContractChatEngine(
  params: SessionContractChatEngineParams,
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    const store = params.crankStore ?? defaultCrankStore;
    const sessionId = params.conversationId;
    const session = createCrankSession(store, sessionId);
    const before = yield* store.readJournal(sessionId);
    const cursor = before.length - 1;
    const pendingPublicInputs = before
      .flatMap((record) => projectRecord(record, before))
      .map((envelope) => envelope.event)
      .filter(
        (event): event is Extract<PublicEvent, { type: "input_requested" }> =>
          event.type === "input_requested" &&
          !before.some(
            (record) =>
              record.payload.type === "pull_resolved" && record.payload.pullId === event.pullId,
          ),
      );
    const programs = toolPrograms(params);
    const rootProgram = createChatProgram();
    const runtime = createCrankRuntime({
      store,
      rootProgram,
      programVersion: "durable-chat/crank-v1",
      programs,
      effects: {
        "model.sample": (input, context) => sampleModel(params, input, context),
        "tool.execute": (input, context) => executeTool(params, input, context),
        "tool.resume": (input, context) => resumeTool(params, input, context),
      },
    });

    const responses = params.elicitResponses ?? [];
    let boundedOutcome: "pending_input" | "duplicate_resume" | "resume_unavailable" | undefined;
    if (params.pluginAbort) {
      const activeTurn = [...before].reverse().find((record) => {
        if (record.payload.type !== "turn_opened") return false;
        const taskId = record.payload.taskId;
        return !before.some(
          (candidate) =>
            candidate.payload.type === "task_closed" && candidate.payload.taskId === taskId,
        );
      });
      if (activeTurn?.payload.type === "turn_opened") {
        yield* session.cancelTurn(activeTurn.payload.turnId, {
          commandId: `cancel:${params.pluginAbort.sessionId}:${params.agUiRun.runId}`,
          ...(params.pluginAbort.reason ? { reason: params.pluginAbort.reason } : {}),
        });
      }
    } else if (responses.length > 0) {
      const records = yield* store.readJournal(sessionId);
      let acceptedResponses = 0;
      for (const response of responses) {
        const pending = [...records].reverse().find((record) => {
          if (
            record.payload.type !== "pull_requested" ||
            record.payload.descriptor.kind !== "elicit"
          )
            return false;
          const context = record.payload.descriptor.input.context;
          if (!context || Array.isArray(context) || typeof context !== "object") return false;
          const pullId = record.payload.pullId;
          return (
            context["callId"] === response.callId &&
            (context["elicitId"] === response.elicitId || pullId === response.elicitId) &&
            !records.some(
              (candidate) =>
                candidate.payload.type === "pull_resolved" && candidate.payload.pullId === pullId,
            )
          );
        });
        if (pending?.payload.type === "pull_requested") {
          const acknowledgement = yield* session.respond(
            pending.payload.pullId,
            response.result as unknown as Json,
            {
              commandId: `respond:${params.agUiRun.runId}:${response.elicitId}`,
            },
          );
          if (acknowledgement.status === "accepted" || acknowledgement.status === "duplicate")
            acceptedResponses += 1;
        }
      }
      if (acceptedResponses === responses.length && acceptedResponses > 0) {
        if (params.onResumeAccepted) yield* params.onResumeAccepted();
      } else if (acceptedResponses === 0) {
        boundedOutcome = params.resumeAlreadyApplied ? "duplicate_resume" : "resume_unavailable";
      }
    } else {
      const message = latestUserMessage(params);
      yield* session.send(turnInput(params, message, before), {
        commandId: message.id ? `send:${message.id}` : `send:${params.agUiRun.runId}`,
      });
      if (pendingPublicInputs.length > 0) boundedOutcome = "pending_input";
    }

    startDetachedActivation(runtime, sessionId);

    const events = yield* session.events(cursor);
    const queue: StreamEvent[] = [];
    if (boundedOutcome === "pending_input") {
      for (const event of pendingPublicInputs)
        queue.push(...projectCrankEventToAgUi(event, params, false, new Map()));
    } else if (boundedOutcome === "duplicate_resume") {
      queue.push({ type: "RUN_FINISHED", ...params.agUiRun, outcome: { type: "success" } });
    } else if (boundedOutcome === "resume_unavailable") {
      queue.push({
        type: "RUN_ERROR",
        message: "The requested input is no longer pending",
        code: "RESUME_UNAVAILABLE",
      });
    }
    let done = boundedOutcome !== undefined;
    let textOpen = false;
    const publicToolNames = new Map<string, string>();
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        while (queue.length === 0 && !done) {
          const next = yield* events.next();
          if (next.done) {
            done = true;
            break;
          }
          const projected = projectCrankEventToAgUi(
            next.value.event,
            params,
            textOpen,
            publicToolNames,
          );
          for (const event of projected) {
            if (event.type === "TEXT_MESSAGE_START") textOpen = true;
            if (event.type === "TEXT_MESSAGE_END") textOpen = false;
            queue.push(event);
          }
          if (
            next.value.event.type === "input_requested" ||
            next.value.event.type === "turn_finished" ||
            next.value.event.type === "session_closed"
          )
            done = true;
        }
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        return { done: true, value: undefined };
      },
    });
  });
}

function createChatProgram(): ProgramFactory {
  return function* (rawInput) {
    const input = asObject(rawInput);
    const messages = Array.isArray(input["messages"]) ? ([...input["messages"]] as Json[]) : [];
    const systemPrompt =
      typeof input["systemPrompt"] === "string" ? input["systemPrompt"] : undefined;
    const initialToolChoice =
      input["initialToolChoice"] === "auto" ||
      input["initialToolChoice"] === "none" ||
      input["initialToolChoice"] === "required"
        ? input["initialToolChoice"]
        : undefined;
    const maxIterations = typeof input["maxIterations"] === "number" ? input["maxIterations"] : 10;
    const hasPriorAssistantOrTool = messages.some((message) => {
      const role = asObject(message)["role"];
      return role === "assistant" || role === "tool" || role === "toolResult";
    });
    const completedCallIds = new Set<string>();
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const sampled = asObject(
        yield* effect<Json>("model.sample", {
          messages,
          ...(systemPrompt ? { systemPrompt } : {}),
          ...(iteration === 0 && !hasPriorAssistantOrTool && initialToolChoice
            ? { toolChoice: initialToolChoice }
            : {}),
        }),
      );
      const calls = Array.isArray(sampled["calls"]) ? sampled["calls"].map(asObject) : [];
      const text = typeof sampled["text"] === "string" ? sampled["text"] : "";
      if (
        calls.length === 0 ||
        calls.every((call) => completedCallIds.has(String(call["id"] ?? "")))
      ) {
        yield* emit("message_committed", { message: { role: "assistant", content: text } });
        return text;
      }
      calls.forEach((call) => completedCallIds.add(String(call["id"] ?? "")));
      messages.push({ role: "assistant", content: text, tool_calls: calls } as Json);
      const results = yield* all<Json[]>(
        calls.map((call) => ({
          programId: `tool.${String(call["target"] ?? "unknown")}`,
          input: {
            target: String(call["target"] ?? "unknown"),
            callId: String(call["id"] ?? `call-${iteration}`),
            input: (call["input"] ?? {}) as Json,
          },
        })),
      );
      calls.forEach((call, index) => {
        const execution = asObject(results[index]);
        messages.push({
          role: "tool",
          tool_call_id: String(call["id"] ?? `call-${iteration}`),
          tool_name: String(call["target"] ?? "tool"),
          content:
            execution["kind"] === "completed"
              ? (execution["result"] ?? null)
              : (results[index] ?? null),
        } as Json);
      });
    }
    throw new Error("Maximum tool iterations reached");
  };
}

function toolPrograms(params: SessionContractChatEngineParams): Record<string, ProgramFactory> {
  return Object.fromEntries(params.toolSchemas.map((tool) => [`tool.${tool.name}`, toolProgram]));
}

const toolProgram: ProgramFactory = function* (rawInput) {
  const input = asObject(rawInput);
  let execution = asObject(yield* effect<Json>("tool.execute", rawInput));
  while (execution["kind"] === "awaiting_elicit") {
    const request = asObject(execution["request"]);
    const answer = yield* elicit<Json>("tool.elicit", {
      key: String(request["key"] ?? "input"),
      message: String(request["message"] ?? "Input required"),
      responseSchema: (request["schema"] ?? {}) as Json,
      context: {
        ...asObject(request["context"]),
        callId: String(input["callId"] ?? ""),
        elicitId: String(request["elicitId"] ?? request["key"] ?? "input"),
        toolName: String(input["target"] ?? ""),
      },
    });
    execution = asObject(
      yield* effect<Json>("tool.resume", {
        ref: (execution["ref"] ?? null) as Json,
        elicitId: String(request["elicitId"] ?? request["key"] ?? ""),
        answer,
        target: String(input["target"] ?? ""),
        callId: String(input["callId"] ?? ""),
      }),
    );
  }
  return execution as Json;
};

function* sampleModel(
  params: SessionContractChatEngineParams,
  rawInput: Json,
  context: EffectContext,
): Operation<Json> {
  const input = asObject(rawInput);
  const runtimeContext: RuntimeContext = {
    ...(typeof input["systemPrompt"] === "string" ? { systemPrompt: input["systemPrompt"] } : {}),
    messages: (Array.isArray(input["messages"]) ? input["messages"] : []).map(toRuntimeMessage),
    tools: params.toolSchemas.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
  const stream = params.runtime.stream(params.model, runtimeContext, {
    ...params.streamOptions,
    signal: params.signal,
    // Stable across at-least-once re-dispatch; providers may use this as a
    // request/session idempotency key.
    sessionId: context.pullId,
    ...(input["toolChoice"] === "auto" ||
    input["toolChoice"] === "none" ||
    input["toolChoice"] === "required"
      ? { toolChoice: input["toolChoice"] }
      : {}),
  });
  const subscription = yield* stream;
  let text = "";
  const calls: Array<{ id: string; target: string; input: Json }> = [];
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      text ||= textFromAssistant(next.value);
      for (const block of next.value.content) {
        if (block.type !== "toolCall") continue;
        const call = canonicalCall(block, params);
        if (call && !calls.some((candidate) => candidate.id === call.id)) calls.push(call);
      }
      return { text, calls };
    }
    if (next.value.type === "text_delta") {
      text += next.value.delta;
      yield* context.emit({
        type: "text_delta",
        messageId: context.pullId,
        delta: next.value.delta,
      });
    }
    if (next.value.type === "toolcall_end") {
      const call = canonicalCall(next.value.toolCall, params);
      if (call && !calls.some((candidate) => candidate.id === call.id)) calls.push(call);
    }
    if (next.value.type === "error")
      throw new Error(next.value.error.errorMessage ?? "Model runtime error");
  }
}

function* executeTool(
  params: SessionContractChatEngineParams,
  rawInput: Json,
  context: EffectContext,
): Operation<Json> {
  const input = asObject(rawInput);
  const target = String(input["target"] ?? "");
  const callId = String(input["callId"] ?? `call:${target}`);
  const plugin = params.mcpToolRegistry?.get(target);
  if (plugin && params.pluginSessionManager) {
    const session = yield* params.pluginSessionManager.create({
      tool: plugin as never,
      params: input["input"],
      callId,
      signal: params.signal,
    });
    return yield* normalizePluginEvent(yield* session.nextEvent(), target, callId);
  }
  const entry = params.toolInventoryEntries?.find(
    (candidate) => candidate.definition.name === target,
  );
  if (!entry || !params.toolRuntime)
    return {
      kind: "completed",
      callId,
      toolName: target,
      result: `Error: Tool not found: ${target}`,
    };
  try {
    const execution = yield* params.toolRuntime.execute({
      entry,
      call: {
        id: callId,
        type: "function",
        function: { name: target, arguments: asRecord(input["input"]) },
      },
      signal: params.signal,
      metadata: {
        threadId: params.agUiRun.threadId,
        runId: params.agUiRun.runId,
        pullId: context.pullId,
        attemptId: context.attemptId,
      },
    });
    return yield* normalizeExecution(execution, target);
  } catch (error) {
    const validation = getToolParameterValidationErrorPayload(error);
    return {
      kind: "completed",
      callId,
      toolName: target,
      result: `Error: ${validation?.message ?? errorMessage(error)}`,
      ...(validation ? { error: validation as unknown as Json } : {}),
    };
  }
}

function* resumeTool(
  params: SessionContractChatEngineParams,
  rawInput: Json,
  context: EffectContext,
): Operation<Json> {
  const input = asObject(rawInput);
  const answer = asObject(input["answer"]);
  const request = asObject(input["ref"]);
  if (request["runtimeId"] === "plugin" && params.pluginSessionManager) {
    const callId = String(input["callId"] ?? request["callId"] ?? "");
    const session = yield* params.pluginSessionManager.get(callId);
    if (!session) return { kind: "failed", error: "Plugin continuation unavailable" };
    yield* session.respondToElicit(String(request["elicitId"] ?? ""), answer as never);
    return yield* normalizePluginEvent(
      yield* session.nextEvent(),
      String(input["target"] ?? session.toolName),
      callId,
    );
  }
  if (!params.toolRuntime || !input["ref"] || typeof input["ref"] !== "object")
    return { kind: "failed", error: "Tool continuation unavailable" };
  const execution = yield* params.toolRuntime.resume({
    ref: input["ref"] as never,
    input: {
      type: "elicit_response",
      elicitId: String(input["elicitId"] ?? request["elicitId"] ?? answer["elicitId"] ?? ""),
      result: answer as never,
    },
    signal: params.signal,
    metadata: {
      threadId: params.agUiRun.threadId,
      runId: params.agUiRun.runId,
      pullId: context.pullId,
      attemptId: context.attemptId,
    },
  });
  return yield* normalizeExecution(execution, String(input["target"] ?? "tool"));
}

function* normalizePluginEvent(
  event: PluginSessionEvent | null,
  target: string,
  callId: string,
): Operation<Json> {
  if (!event) return { kind: "failed", error: "Plugin session ended without a result" };
  if (event.type === "result")
    return { kind: "completed", callId, toolName: target, result: event.result as Json };
  if (event.type === "elicit_request")
    return {
      kind: "awaiting_elicit",
      ref: { runtimeId: "plugin", callId, elicitId: event.elicitId },
      request: {
        elicitId: event.elicitId,
        key: event.key,
        message: event.message,
        schema: event.schema as Json,
        ...(event.context ? { context: event.context as Json } : {}),
      },
    };
  if (event.type === "error")
    return { kind: "completed", callId, toolName: target, result: `Error: ${event.message}` };
  return { kind: "failed", error: event.reason ?? "cancelled" };
}

function* normalizeExecution(execution: ToolExecution, target: string): Operation<Json> {
  if (execution.kind === "completed")
    return {
      kind: "completed",
      callId: execution.ref.callId,
      toolName: target,
      result: execution.result as Json,
    };
  if (execution.kind === "failed")
    return {
      kind: "completed",
      callId: execution.ref.callId,
      toolName: target,
      result: `Error: ${execution.error.message}`,
    };
  if (execution.kind === "awaiting_elicit")
    return {
      kind: "awaiting_elicit",
      ref: execution.ref as unknown as Json,
      request: execution.request as unknown as Json,
    };
  const events = yield* execution.events;
  while (true) {
    const next = yield* events.next();
    if (next.done) return { kind: "failed", error: "Tool execution ended without a result" };
    const event = next.value;
    if (event.type === "elicit_request")
      return {
        kind: "awaiting_elicit",
        ref: execution.ref as unknown as Json,
        request: event as unknown as Json,
      };
    if (event.type === "result")
      return {
        kind: "completed",
        callId: execution.ref.callId,
        toolName: target,
        result: event.result as Json,
      };
    if (event.type === "error")
      return {
        kind: "completed",
        callId: execution.ref.callId,
        toolName: target,
        result: `Error: ${event.message}`,
      };
    if (event.type === "cancelled") return { kind: "failed", error: event.reason ?? "cancelled" };
  }
}

export function projectCrankEventToAgUi(
  event: PublicEvent,
  params: SessionContractChatEngineParams,
  textOpen: boolean,
  toolNames: Map<string, string>,
): StreamEvent[] {
  switch (event.type) {
    case "turn_started":
      return [];
    case "text_started":
      return textOpen
        ? []
        : [
            {
              type: "TEXT_MESSAGE_START",
              messageId: assistantMessageId(params),
              role: "assistant",
            },
          ];
    case "text_delta":
      return [
        ...(textOpen
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
    case "attempt_abandoned":
      return [
        ...(textOpen
          ? [{ type: "TEXT_MESSAGE_END" as const, messageId: assistantMessageId(params) }]
          : []),
        {
          type: "MESSAGES_SNAPSHOT",
          messages: params.messages.map((message, index) =>
            internalMessageToAgUiMessage(message as never, `history:${index}`),
          ),
        },
      ];
    case "tool_started":
      toolNames.set(event.toolCallId, event.name);
      return [
        ...(textOpen
          ? [{ type: "TEXT_MESSAGE_END" as const, messageId: assistantMessageId(params) }]
          : []),
        {
          type: "TOOL_CALL_START",
          toolCallId: event.toolCallId,
          toolCallName: event.name,
          parentMessageId: `assistant:tools:${event.toolCallId}`,
        },
        ...(event.input !== undefined
          ? [
              {
                type: "TOOL_CALL_ARGS" as const,
                toolCallId: event.toolCallId,
                delta: JSON.stringify(event.input),
              },
            ]
          : []),
      ];
    case "tool_completed": {
      const completed = asObject(event.result);
      const content = "result" in completed ? completed["result"] : event.result;
      return [
        { type: "TOOL_CALL_END", toolCallId: event.toolCallId },
        {
          type: "TOOL_CALL_RESULT",
          messageId: `tool:${event.toolCallId}`,
          toolCallId: event.toolCallId,
          ...(toolNames.get(event.toolCallId)
            ? { toolCallName: toolNames.get(event.toolCallId)! }
            : {}),
          content: stringify(content),
          role: "tool",
          ...(completed["error"] && typeof completed["error"] === "object"
            ? { error: completed["error"] as never }
            : {}),
        },
      ];
    }
    case "input_requested":
      return [
        ...(textOpen
          ? [{ type: "TEXT_MESSAGE_END" as const, messageId: assistantMessageId(params) }]
          : []),
        {
          type: "RUN_FINISHED",
          ...params.agUiRun,
          outcome: {
            type: "interrupt",
            interrupts: [
              {
                id: event.pullId,
                reason: "input_required",
                message: event.message,
                responseSchema: asRecord(event.responseSchema),
                ...(event.context &&
                !Array.isArray(event.context) &&
                typeof event.context === "object" &&
                typeof event.context["callId"] === "string"
                  ? { toolCallId: event.context["callId"] }
                  : {}),
                metadata: {
                  "sweatpants/key": event.key,
                  ...(event.context &&
                  !Array.isArray(event.context) &&
                  typeof event.context === "object"
                    ? {
                        ...(typeof event.context["toolName"] === "string"
                          ? { "sweatpants/toolName": event.context["toolName"] }
                          : {}),
                        ...(typeof event.context["callId"] === "string"
                          ? { callId: event.context["callId"] }
                          : {}),
                        ...(typeof event.context["elicitId"] === "string"
                          ? { elicitId: event.context["elicitId"] }
                          : {}),
                      }
                    : {}),
                },
              },
            ],
          },
        },
      ];
    case "turn_finished":
      return [
        ...(textOpen
          ? [{ type: "TEXT_MESSAGE_END" as const, messageId: assistantMessageId(params) }]
          : []),
        ...(event.outcome === "completed"
          ? [
              {
                type: "RUN_FINISHED" as const,
                ...params.agUiRun,
                outcome: { type: "success" as const },
              },
            ]
          : [
              {
                type: "RUN_ERROR" as const,
                message: event.message ?? event.code ?? event.outcome,
                code: event.code ?? "RUN_ABORTED",
              },
            ]),
      ];
    case "session_closed":
      return [
        { type: "RUN_ERROR", message: event.reason ?? "Session closed", code: "SESSION_CLOSED" },
      ];
    case "message_committed":
    case "input_resolved":
      return [];
  }
}

function canonicalCall(
  call: ToolCallBlock,
  params: SessionContractChatEngineParams,
): { id: string; target: string; input: Json } | null {
  const exact = params.toolSchemas.find((tool) => tool.name === call.name);
  const aliases = params.toolSchemas.filter((tool) => tool.name.startsWith(`${call.name}_`));
  const target = exact?.name ?? (aliases.length === 1 ? aliases[0]!.name : undefined);
  if (!target) return null;
  const id = call.id || `${assistantMessageId(params)}:${target}`;
  return { id, target, input: call.arguments as Json };
}

export function toRuntimeMessage(value: Json): RuntimeMessage {
  const message = asObject(value);
  const role = message["role"];
  const content =
    typeof message["content"] === "string" ? message["content"] : stringify(message["content"]);
  if (role === "assistant") {
    const runtimeContent = Array.isArray(message["runtime_content"])
      ? message["runtime_content"].flatMap((block) => {
          const parsed = parseRuntimeContentBlock(block);
          return parsed ? [parsed] : [];
        })
      : undefined;
    const toolCalls = Array.isArray(message["tool_calls"])
      ? message["tool_calls"].map(asObject)
      : [];
    return {
      role: "assistant",
      content: runtimeContent ?? [
        ...(content ? [{ type: "text" as const, text: content }] : []),
        ...toolCalls.map((call) => {
          const fn = asObject(call["function"]);
          return {
            type: "toolCall" as const,
            id: String(call["id"] ?? "tool"),
            name: String(call["target"] ?? call["name"] ?? fn["name"] ?? "tool"),
            arguments: toolCallArguments(call["input"] ?? call["arguments"] ?? fn["arguments"]),
            ...(typeof call["thoughtSignature"] === "string"
              ? { thoughtSignature: call["thoughtSignature"] }
              : {}),
          };
        }),
      ],
    };
  }
  if (role === "tool")
    return {
      role: "toolResult",
      toolCallId: String(message["tool_call_id"] ?? "tool"),
      toolName: String(message["tool_name"] ?? "tool"),
      content: [{ type: "text", text: content }],
      isError: false,
    };
  if (role === "system") return { role: "system", content };
  return { role: "user", content };
}

function parseRuntimeContentBlock(value: Json): ContentBlock | undefined {
  const block = asObject(value);
  switch (block["type"]) {
    case "text":
      return typeof block["text"] === "string"
        ? {
            type: "text",
            text: block["text"],
            ...(typeof block["textSignature"] === "string"
              ? { textSignature: block["textSignature"] }
              : {}),
          }
        : undefined;
    case "thinking":
      return typeof block["text"] === "string"
        ? {
            type: "thinking",
            text: block["text"],
            ...(typeof block["format"] === "string" ? { format: block["format"] } : {}),
            ...(typeof block["thinkingSignature"] === "string"
              ? { thinkingSignature: block["thinkingSignature"] }
              : {}),
            ...(typeof block["redacted"] === "boolean" ? { redacted: block["redacted"] } : {}),
          }
        : undefined;
    case "toolCall":
      return typeof block["id"] === "string" && typeof block["name"] === "string"
        ? {
            type: "toolCall",
            id: block["id"],
            name: block["name"],
            arguments: toolCallArguments(block["arguments"]),
            ...(typeof block["thoughtSignature"] === "string"
              ? { thoughtSignature: block["thoughtSignature"] }
              : {}),
          }
        : undefined;
    case "image":
      return typeof block["data"] === "string" && typeof block["mimeType"] === "string"
        ? { type: "image", data: block["data"], mimeType: block["mimeType"] }
        : undefined;
    default:
      return undefined;
  }
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

function turnInput(
  params: SessionContractChatEngineParams,
  message: { id?: string; role: "user"; content: string },
  journal: readonly JournalRecord[],
): Json {
  const messages = repairToolHistory(params.messages as unknown as Json[], journal);
  return {
    messages,
    message,
    maxIterations: params.maxIterations,
    ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.initialToolChoice ? { initialToolChoice: params.initialToolChoice } : {}),
  };
}

export function repairToolHistory(messages: Json[], journal: readonly JournalRecord[]): Json[] {
  const calls = new Map<string, { target: string; input: Json }>();
  for (const record of journal) {
    if (record.payload.type !== "task_opened") continue;
    const input = asObject(record.payload.input);
    const callId = typeof input["callId"] === "string" ? input["callId"] : undefined;
    const target = typeof input["target"] === "string" ? input["target"] : undefined;
    if (callId && target) calls.set(callId, { target, input: (input["input"] ?? {}) as Json });
  }

  const output: Json[] = [];
  const declared = new Set<string>();
  for (const raw of messages) {
    const current = { ...asObject(raw) };
    if (current["role"] === "assistant" && Array.isArray(current["tool_calls"])) {
      for (const call of current["tool_calls"].map(asObject)) {
        if (typeof call["id"] === "string") declared.add(call["id"]);
      }
    }
    if (current["role"] === "tool") {
      const callId = String(current["tool_call_id"] ?? "");
      const durable = calls.get(callId);
      if (callId && durable && !declared.has(callId)) {
        output.push({
          role: "assistant",
          content: "",
          tool_calls: [{ id: callId, target: durable.target, input: durable.input }],
        });
        declared.add(callId);
        current["tool_name"] = durable.target;
      }
    }
    output.push(current as Json);
  }
  return output;
}

function latestUserMessage(params: SessionContractChatEngineParams): {
  id?: string;
  role: "user";
  content: string;
} {
  const last = [...params.messages].reverse().find((message) => message.role === "user");
  return {
    role: "user",
    content: last?.content ?? "",
    ...(typeof last?.id === "string" ? { id: last.id } : {}),
  };
}

function assistantMessageId(params: SessionContractChatEngineParams): string {
  return `assistant:final:${params.agUiRun.runId}`;
}
function asObject(value: unknown): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function toolCallArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
}
function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
