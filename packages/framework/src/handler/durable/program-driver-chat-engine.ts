import { resource, type Operation, type Stream } from "effection";
import {
  CrankError,
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  assertJson,
  assertSchemaValue,
  canonicalJson,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createDurableTool,
  createDurableToolRegistry,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  defineDurableEffect,
  defineDurableProgramManifest,
  foreignToolAdapter,
  sha256,
  stableProgramAttachmentId,
  type DurableEffectRegistration,
  type DurableSemanticRecord,
  type DurableTool,
  type Json,
} from "@sweatpants/session-contract";

import type {
  AssistantMessage,
  ContentBlock,
  Context as RuntimeContext,
  Message as RuntimeMessage,
} from "../../lib/chat/runtime/index.ts";
import { buildPluginReplayActivity } from "../../lib/chat/session/plugin-replay.ts";
import type { StreamEvent } from "../../lib/chat/session/streaming.ts";
import {
  nativeProgramIdentities,
  type NativeProgramIdentity,
  type ProgramDriverNativeToolComposition,
} from "./program-driver-native-tools.ts";
import type { ProgramDriverJournal, ProgramDriverJournalStore } from "./program-driver-journal.ts";
import { createToolRuntimeForeignEffectRegistrations } from "./program-driver-tool-runtime.ts";
import type { ElicitResponse, ProgramRuntimeChatEngineParams } from "./types.ts";

type ChatCall = { id: string; target: string; input: Json; thoughtSignature?: string };
type ChatSampleRequest = {
  messages: Json[];
  systemPrompt?: string;
  maxTokens?: number;
  modelPreferences?: Json;
  tools?: Json[];
  toolChoice?: Json;
  schema?: Json;
};
type ChatSampleResult = {
  text: string;
  calls: ChatCall[];
  content: Json[];
  model?: string;
  stopReason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Json }>;
  parsed?: Json;
  parseError?: { message: string; rawText: string };
};
type ChatSampleCancellationPartial = { text: string; interrupted: true };

type ChatProgramInput = ChatSampleRequest & {
  maxIterations: number;
  foreignDriver: "tool-session" | "framework-tool-runtime";
  durablePrograms: Record<string, NativeProgramIdentity>;
};

type ProgramDriverChatEngineParams = ProgramRuntimeChatEngineParams & {
  journalStore: ProgramDriverJournalStore;
  foreignEffects?: readonly [DurableEffectRegistration, DurableEffectRegistration];
  nativeTools?: ProgramDriverNativeToolComposition;
  continueAfterCancellation?: boolean;
};

const modelSample = defineDurableEffect<
  ChatSampleRequest,
  ChatSampleResult,
  ChatSampleCancellationPartial
>({
  name: "model.sample",
  version: "1",
  inputSchema: {
    type: "object",
    required: ["messages"],
    properties: {
      messages: { type: "array", items: true },
      systemPrompt: { type: "string" },
      maxTokens: { type: "integer", minimum: 1 },
      modelPreferences: true,
      tools: { type: "array", items: true },
      toolChoice: true,
      schema: true,
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    required: ["text", "calls", "content"],
    properties: {
      text: { type: "string" },
      calls: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "target", "input"],
          properties: {
            id: { type: "string", minLength: 1 },
            target: { type: "string", minLength: 1 },
            input: true,
            thoughtSignature: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      content: { type: "array", items: true },
      model: { type: "string" },
      stopReason: { type: "string" },
      toolCalls: { type: "array", items: true },
      parsed: true,
      parseError: {
        type: "object",
        required: ["message", "rawText"],
        properties: { message: { type: "string" }, rawText: { type: "string" } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  cancellation: {
    partialSchema: {
      type: "object",
      required: ["text", "interrupted"],
      properties: {
        text: { type: "string", maxLength: 32_768 },
        interrupted: { const: true },
      },
      additionalProperties: false,
    },
  },
  retrySafety: { mode: "idempotent", mechanism: "pull_id_key" },
});

const manifest = defineDurableProgramManifest<ChatProgramInput, string>({
  programId: "sweatpants.chat-root",
  version: "1.1.0",
  digest: sha256("sweatpants.chat-root@1.1.0:native-child-tool-routing-v1"),
  inputSchema: {
    type: "object",
    required: ["messages", "maxIterations", "foreignDriver", "durablePrograms"],
    properties: {
      messages: { type: "array", items: true },
      systemPrompt: { type: "string" },
      toolChoice: { enum: ["auto", "none", "required"] },
      maxIterations: { type: "integer", minimum: 1, maximum: 100 },
      foreignDriver: { enum: ["tool-session", "framework-tool-runtime"] },
      durablePrograms: {
        type: "object",
        additionalProperties: {
          type: "object",
          required: ["id", "version", "digest"],
          properties: {
            id: { type: "string" },
            version: { type: "string" },
            digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  outputSchema: { type: "string" },
  elicits: {},
  effects: { [modelSample.name]: modelSample },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
});

const rootTool = createDurableTool(manifest, function* (input, context) {
  const messages = [...input.messages];
  const hasPriorAssistantOrTool = messages.some((message) => {
    const value = jsonRecord(message);
    return (
      value?.["role"] === "assistant" ||
      value?.["role"] === "tool" ||
      value?.["role"] === "toolResult"
    );
  });
  const completedCallIds = new Set<string>();
  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sampled = yield* context.effect(
      modelSample,
      {
        messages,
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
        ...(iteration === 0 && !hasPriorAssistantOrTool && input.toolChoice !== undefined
          ? { toolChoice: input.toolChoice }
          : {}),
      },
      { audience: "model-runtime" },
    );
    const calls = sampled.calls.filter((call) => !completedCallIds.has(call.id));
    if (calls.length === 0) {
      yield* context.emit("assistant_text", { text: sampled.text });
      return sampled.text;
    }
    for (const call of calls) {
      completedCallIds.add(call.id);
    }
    messages.push({
      role: "assistant",
      content: sampled.text,
      tool_calls: calls,
      runtime_content: sampled.content,
    });
    for (const call of calls) {
      yield* context.emit("tool_started", {
        callId: call.id,
        tool: call.target,
        input: call.input,
      });
      const nativeProgram = input.durablePrograms[call.target];
      const result = nativeProgram
        ? yield* context.invoke<Json>({
            ...nativeProgram,
            input: durableToolInput(call),
          })
        : yield* context.foreignTool<Json>({
            driver: input.foreignDriver,
            tool: call.target,
            input: call.input,
            durability: "ephemeral_handle",
            route: call.id,
          });
      yield* context.emit("tool_completed", {
        callId: call.id,
        tool: call.target,
        result,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        tool_name: call.target,
        content: result,
      });
    }
  }
  throw new CrankError("max_tool_iterations", "Maximum tool iterations reached");
});

/** Runs one HTTP chat activation through the crank-native ProgramRuntime. */
export function createProgramDriverChatEngine(
  params: ProgramDriverChatEngineParams,
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    let events: StreamEvent[] | undefined;
    let cursor = 0;
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        events ??= yield* activateProgramDriverChatEngine(params);
        const event = events[cursor];
        if (!event) {
          return { done: true, value: undefined };
        }
        cursor += 1;
        return { done: false, value: event };
      },
    });
  });
}

function* activateProgramDriverChatEngine(
  params: ProgramDriverChatEngineParams,
): Operation<StreamEvent[]> {
  const journal = yield* params.journalStore.open(params.conversationId);
  const scopedForeignEffects = params.foreignEffects;
  let before = yield* journal.readJournal(params.conversationId);
  const active = activeRoot(before);
  const turnNumber = rootTaskCount(before);
  const taskId = active?.taskId ?? `turn-${turnNumber}/root`;
  const turnId = active?.turnId ?? `turn-${turnNumber}`;
  const requestedInput: ChatProgramInput = {
    messages: params.messages.map((message) => assertJson(message)),
    maxIterations: params.maxIterations,
    foreignDriver: scopedForeignEffects ? "tool-session" : "framework-tool-runtime",
    durablePrograms: nativeProgramIdentities(params.nativeTools),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.initialToolChoice !== undefined ? { toolChoice: params.initialToolChoice } : {}),
  };
  const input = active
    ? assertSchemaValue<ChatProgramInput>(manifest.inputSchema, active.input)
    : requestedInput;
  const attach = {
    sessionId: params.conversationId,
    taskId,
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input,
    route: { driverKind: "generator" },
    executionEpoch: 1,
  };
  if (!active) {
    try {
      yield* journal.openTask({
        sessionId: params.conversationId,
        turnId,
        taskId,
        manifest,
        input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "program-runtime",
      });
    } catch (error) {
      if (!(error instanceof CrankError) || error.code !== "invalid_journal") {
        throw error;
      }
      const raced = activeRoot(yield* journal.readJournal(params.conversationId));
      if (raced?.taskId !== taskId || canonicalJson(raced.input) !== canonicalJson(input)) {
        throw new CrankError("idempotency_conflict", "Concurrent root task input differs");
      }
    }
    before = yield* journal.readJournal(params.conversationId);
  }

  if (active && params.pluginAbort) {
    yield* journal.requestCancellation(
      params.conversationId,
      active.taskId,
      params.pluginAbort.reason,
    );
    yield* cancelPendingElicits(journal, before, params.conversationId);
  }
  const accepted = params.pluginAbort ? 0 : yield* resolveElicitResponses(params, journal, before);
  if (accepted > 0 && params.onResumeAccepted) {
    yield* params.onResumeAccepted();
  }

  // SAFETY: registry storage erases manifest type witnesses; both tools are
  // restored from their exact pinned schemas before driver execution.
  const tools = createDurableToolRegistry([
    rootTool as unknown as DurableTool,
    foreignToolAdapter as unknown as DurableTool,
    ...[...(params.nativeTools?.bindings.values() ?? [])].map((binding) => binding.tool),
  ]);
  const drivers = createProgramDriverRegistry([
    ["generator", createLocalGeneratorDriver(tools)],
    ...(params.nativeTools?.drivers ?? []),
  ]);
  const foreignEffects =
    input.foreignDriver === "tool-session"
      ? requireScopedForeignEffects(scopedForeignEffects)
      : createToolRuntimeForeignEffectRegistrations({
          runtime: requireToolRuntime(params),
          entries: params.toolInventoryEntries ?? [],
          threadId: params.agUiRun.threadId,
          runId: params.agUiRun.runId,
        });
  const effects = createDurableEffectRegistry([
    createDurableEffectRegistration(
      modelSample,
      { mode: "idempotent", mechanism: "pull_id_key" },
      function* (request, context) {
        let partialText = "";
        try {
          return {
            status: "ok" as const,
            value: yield* sampleModel(
              params,
              request,
              context.cancellation,
              context.pullId,
              (text) => {
                partialText = text.slice(-32_768);
              },
            ),
          };
        } catch (error) {
          if (context.cancellation.aborted) {
            return {
              status: "cancelled" as const,
              partial: { text: partialText, interrupted: true as const },
            };
          }
          if (error instanceof CrankError) {
            throw error;
          }
          throw new CrankError("model_runtime_failed", "Provider error");
        }
      },
    ),
    ...foreignEffects,
    ...(params.nativeTools?.effects ?? []),
  ]);
  const outcome = yield* ProgramDriverRegistryContext.with(drivers, function* () {
    return yield* JournalAuthorityContext.with(journal.authority, function* () {
      return yield* DurableEffectRegistryContext.with(effects, function* () {
        return yield* ProgramRouteResolverContext.with(
          function* (program, parentRoute) {
            const binding = [...(params.nativeTools?.bindings.values() ?? [])].find(
              (candidate) =>
                candidate.tool.manifest.programId === program.id &&
                candidate.tool.manifest.version === program.version &&
                candidate.tool.manifest.digest === program.digest,
            );
            return binding?.route ?? parentRoute;
          },
          function* () {
            return yield* ProgramRuntime.operations.run({ attach, executeHostEffects: true });
          },
        );
      });
    });
  });
  const after = yield* journal.readJournal(params.conversationId);
  const events: StreamEvent[] = (params.elicitResponses ?? []).flatMap((response) => {
    if (!response.trace || !response.toolName) {
      return [];
    }
    const activity = buildPluginReplayActivity({
      toolCallId: response.callId,
      toolName: response.toolName,
      trace: response.trace,
    });
    return activity ? [activity] : [];
  });
  events.push(...projectRecords(after.slice(before.length), after));
  if (outcome.state === "completed") {
    events.push({ type: "RUN_FINISHED", ...params.agUiRun, outcome: { type: "success" } });
  } else if (outcome.state === "parked") {
    const pending = pendingElicit(after, outcome.pullId);
    if (pending) {
      const pendingCallId = pendingToolCallId(pending);
      if (pendingCallId) {
        events.push({ type: "TOOL_CALL_END", toolCallId: pendingCallId });
      }
      events.push(projectInterrupt(pending, params));
    } else {
      events.push({
        type: "RUN_ERROR",
        code: "PROGRAM_PARKED",
        message: "Program parked without a public input request",
      });
    }
  } else if (outcome.state === "cancelled") {
    if (params.continueAfterCancellation) {
      const {
        pluginAbort: _pluginAbort,
        continueAfterCancellation: _continueAfterCancellation,
        ...continuationParams
      } = params;
      const continuation = yield* createProgramDriverChatEngine(continuationParams);
      while (true) {
        const next = yield* continuation.next();
        if (next.done) {
          break;
        }
        events.push(next.value);
      }
    } else {
      events.push({
        type: "RUN_ERROR",
        code: "PROGRAM_CANCELLED",
        message: params.pluginAbort?.reason ?? "Program was cancelled",
      });
    }
  } else {
    events.push({ type: "RUN_ERROR", code: outcome.error.code, message: outcome.error.message });
  }

  return events;
}

function* sampleModel(
  params: ProgramRuntimeChatEngineParams,
  request: ChatSampleRequest,
  cancellation: AbortSignal,
  pullId: string,
  onText?: (text: string) => void,
): Operation<ChatSampleResult> {
  const foreignSamplingRequest =
    request.maxTokens !== undefined ||
    request.modelPreferences !== undefined ||
    request.tools !== undefined ||
    request.schema !== undefined;
  const runtimeContext: RuntimeContext = {
    ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
    messages: request.messages.map(toRuntimeMessage),
    ...(request.tools !== undefined
      ? { tools: sampleTools(request.tools) }
      : foreignSamplingRequest
        ? {}
        : {
            tools: params.toolSchemas.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
          }),
  };
  const stream = params.runtime.stream(params.model, runtimeContext, {
    ...params.streamOptions,
    signal: cancellation,
    sessionId: pullId,
    ...(request.toolChoice === "auto" ||
    request.toolChoice === "none" ||
    request.toolChoice === "required"
      ? { toolChoice: request.toolChoice }
      : {}),
    ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
    ...(jsonRecord(request.schema)
      ? {
          responseFormat: {
            type: "json_schema" as const,
            name: "foreign_sample",
            schema: objectSchema(request.schema),
          },
        }
      : {}),
  });
  const subscription = yield* stream;
  let text = "";
  const calls: ChatCall[] = [];
  while (true) {
    const next = yield* subscription.next();
    if (next.done) {
      if (!text) {
        for (const block of next.value.content) {
          if (block.type === "text") {
            text += block.text;
          }
        }
      }
      for (const block of next.value.content) {
        if (block.type === "toolCall" && !calls.some((call) => call.id === block.id)) {
          calls.push({
            id: block.id,
            target: foreignSamplingRequest
              ? block.name
              : resolveOuterToolTarget(block.name, params.toolSchemas),
            input: assertJson(block.arguments),
            ...(block.thoughtSignature !== undefined
              ? { thoughtSignature: block.thoughtSignature }
              : {}),
          });
        }
      }
      const base: ChatSampleResult = {
        text,
        calls,
        content: snapshotAssistantContent(next.value.content),
        model: params.model.id,
        stopReason: calls.length > 0 ? "toolUse" : "endTurn",
      };
      if (request.schema !== undefined) {
        const schemaCall = calls[0];
        if (schemaCall) {
          return { ...base, parsed: schemaCall.input };
        }
        try {
          return { ...base, parsed: assertJson(JSON.parse(text)) };
        } catch {
          return {
            ...base,
            parsed: null,
            parseError: { message: "Failed to parse structured sample", rawText: text },
          };
        }
      }
      if (request.tools !== undefined && calls.length > 0) {
        return {
          ...base,
          toolCalls: calls.map((call) => ({
            id: call.id,
            name: call.target,
            arguments: call.input,
          })),
        };
      }
      return base;
    }
    if (next.value.type === "text_delta") {
      text += next.value.delta;
      onText?.(text);
    }
    if (next.value.type === "toolcall_end") {
      const block = next.value.toolCall;
      if (!calls.some((call) => call.id === block.id)) {
        calls.push({
          id: block.id,
          target: foreignSamplingRequest
            ? block.name
            : resolveOuterToolTarget(block.name, params.toolSchemas),
          input: assertJson(block.arguments),
          ...(block.thoughtSignature !== undefined
            ? { thoughtSignature: block.thoughtSignature }
            : {}),
        });
      }
    }
    if (next.value.type === "error") {
      throw new CrankError("model_runtime_failed", "Model runtime failed");
    }
  }
}

function activeRoot(records: DurableSemanticRecord[]) {
  const closed = new Set(
    records.flatMap((record) =>
      record.payload.type === "TaskClosed" ? [record.payload.taskId] : [],
    ),
  );
  const opened = records.filter(
    (record) =>
      record.payload.type === "TaskOpened" &&
      record.payload.parentTaskId === undefined &&
      !closed.has(record.payload.taskId),
  );
  const latest = opened.at(-1);
  return latest?.payload.type === "TaskOpened" ? latest.payload : undefined;
}

function rootTaskCount(records: DurableSemanticRecord[]): number {
  return records.filter(
    (record) => record.payload.type === "TaskOpened" && record.payload.parentTaskId === undefined,
  ).length;
}

function* cancelPendingElicits(
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
  sessionId: string,
): Operation<void> {
  const resolved = new Set(
    records.flatMap((entry) =>
      entry.payload.type === "PullResolved" ? [entry.payload.pullId] : [],
    ),
  );
  for (const entry of records) {
    const payload = entry.payload;
    if (
      payload.type !== "PullRequested" ||
      payload.descriptor.kind !== "elicit" ||
      resolved.has(payload.pullId)
    ) {
      continue;
    }
    const result = yield* journal.resolvePending({
      sessionId,
      taskId: payload.taskId,
      pullId: payload.pullId,
      audience: `user:${payload.descriptor.key}`,
      outcome: { status: "cancelled" },
    });
    if (
      result.status === "rejected" &&
      result.code !== "capability_revoked" &&
      result.code !== "task_terminal"
    ) {
      throw new CrankError(result.code, "Pending cancellation was rejected");
    }
  }
}

function* resolveElicitResponses(
  params: ProgramRuntimeChatEngineParams,
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
): Operation<number> {
  let accepted = 0;
  for (const response of params.elicitResponses ?? []) {
    const pending = findPendingResponse(records, response);
    if (!pending) {
      continue;
    }
    const result = yield* journal.resolvePending({
      sessionId: params.conversationId,
      taskId: pending.taskId,
      pullId: pending.pullId,
      audience: `user:${pending.key}`,
      outcome: { status: "ok", value: assertJson(response.result) },
    });
    if (result.status === "accepted" || result.status === "duplicate") {
      accepted += 1;
    }
  }
  return accepted;
}

function findPendingResponse(records: DurableSemanticRecord[], response: ElicitResponse) {
  const resolved = new Set(
    records.flatMap((record) =>
      record.payload.type === "PullResolved" ? [record.payload.pullId] : [],
    ),
  );
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload;
    if (
      payload?.type !== "PullRequested" ||
      payload.descriptor.kind !== "elicit" ||
      resolved.has(payload.pullId)
    ) {
      continue;
    }
    const context = jsonRecord(payload.descriptor.context);
    const nested = jsonRecord(context?.["context"]);
    if (
      foreignCallId(context, nested) === response.callId &&
      (foreignElicitId(context, nested) === response.elicitId ||
        payload.pullId === response.elicitId)
    ) {
      return {
        taskId: payload.taskId,
        pullId: payload.pullId,
        key: payload.descriptor.key,
      };
    }
  }
  return undefined;
}

type PullRequestedPayload = Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }>;
type PendingElicit = Omit<PullRequestedPayload, "descriptor"> & {
  descriptor: Extract<PullRequestedPayload["descriptor"], { kind: "elicit" }>;
};

function pendingElicit(
  records: DurableSemanticRecord[],
  pullId: string,
): PendingElicit | undefined {
  const resolved = records.some(
    (record) => record.payload.type === "PullResolved" && record.payload.pullId === pullId,
  );
  if (resolved) {
    return undefined;
  }
  const found = records.find(
    (record) =>
      record.payload.type === "PullRequested" &&
      record.payload.pullId === pullId &&
      record.payload.descriptor.kind === "elicit",
  );
  if (found?.payload.type !== "PullRequested" || found.payload.descriptor.kind !== "elicit") {
    return undefined;
  }
  return { ...found.payload, descriptor: found.payload.descriptor };
}

function projectRecords(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const activeToolCalls = new Set<string>();
  for (const recordEntry of records) {
    if (recordEntry.payload.type === "PullResolved") {
      const partial =
        recordEntry.payload.outcome.status === "cancelled"
          ? jsonRecord(recordEntry.payload.outcome.partial)
          : undefined;
      const request = pullRequest(allRecords, recordEntry.payload.pullId);
      if (
        partial?.["interrupted"] === true &&
        typeof partial["text"] === "string" &&
        request?.descriptor.kind === "effect" &&
        request.descriptor.name === modelSample.name
      ) {
        const messageId = `assistant:interrupted:${recordEntry.payload.taskId}:${recordEntry.payload.pullId}`;
        events.push(
          { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId,
            delta: `${partial["text"]}\n\n[interrupted]`,
          },
          { type: "TEXT_MESSAGE_END", messageId },
        );
      }
      continue;
    }
    if (recordEntry.payload.type !== "DurableEmission") {
      continue;
    }
    const descriptor = recordEntry.payload.descriptor;
    const payload = jsonRecord(descriptor.payload);
    if (!payload) {
      continue;
    }
    if (descriptor.eventType === "assistant_text" && typeof payload["text"] === "string") {
      const messageId = `assistant:${recordEntry.payload.taskId}:${recordEntry.payload.emissionIndex}`;
      events.push(
        { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId, delta: payload["text"] },
        { type: "TEXT_MESSAGE_END", messageId },
      );
    }
    if (
      descriptor.eventType === "tool_started" &&
      typeof payload["callId"] === "string" &&
      typeof payload["tool"] === "string"
    ) {
      activeToolCalls.add(payload["callId"]);
      events.push(
        {
          type: "TOOL_CALL_START",
          toolCallId: payload["callId"],
          toolCallName: payload["tool"],
          parentMessageId: `assistant:tools:${payload["callId"]}`,
        },
        {
          type: "TOOL_CALL_ARGS",
          toolCallId: payload["callId"],
          delta: JSON.stringify(payload["input"] ?? null),
        },
      );
    }
    if (
      descriptor.eventType === "tool_completed" &&
      typeof payload["callId"] === "string" &&
      typeof payload["tool"] === "string"
    ) {
      const activeInThisRun = activeToolCalls.delete(payload["callId"]);
      const startedPreviously = previousToolStart(allRecords, payload["callId"]);
      if (activeInThisRun) {
        events.push({ type: "TOOL_CALL_END", toolCallId: payload["callId"] });
      } else if (!startedPreviously) {
        events.push(
          {
            type: "TOOL_CALL_START",
            toolCallId: payload["callId"],
            toolCallName: payload["tool"],
            parentMessageId: `assistant:tools:${payload["callId"]}`,
          },
          { type: "TOOL_CALL_END", toolCallId: payload["callId"] },
        );
      }
      events.push({
        type: "TOOL_CALL_RESULT",
        messageId: `tool:${payload["callId"]}`,
        toolCallId: payload["callId"],
        toolCallName: payload["tool"],
        content: JSON.stringify(payload["result"] ?? null),
        role: "tool",
      });
    }
  }

  const cancellationClosed = records.some(
    (record) =>
      record.payload.type === "TaskClosed" && record.payload.outcome.status === "cancelled",
  );
  if (cancellationClosed) {
    for (const pending of unfinishedToolCalls(allRecords)) {
      const partial = cancellationPartialForCall(allRecords, pending.callId);
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: "TOOL_CALL_END", toolCallId: pending.callId });
      }
      events.push({
        type: "TOOL_CALL_RESULT",
        messageId: `tool:${pending.callId}:cancelled`,
        toolCallId: pending.callId,
        toolCallName: pending.tool,
        content: JSON.stringify({ status: "cancelled", ...(partial ? { partial } : {}) }),
        role: "tool",
      });
    }
  }
  return events;
}

function pullRequest(records: DurableSemanticRecord[], pullId: string) {
  const record = records.find(
    (candidate) =>
      candidate.payload.type === "PullRequested" && candidate.payload.pullId === pullId,
  );
  return record?.payload.type === "PullRequested" ? record.payload : undefined;
}

function unfinishedToolCalls(
  records: DurableSemanticRecord[],
): Array<{ callId: string; tool: string }> {
  const started = new Map<string, string>();
  const completed = new Set<string>();
  for (const record of records) {
    if (record.payload.type !== "DurableEmission") {
      continue;
    }
    const payload = jsonRecord(record.payload.descriptor.payload);
    if (!payload || typeof payload["callId"] !== "string") {
      continue;
    }
    if (
      record.payload.descriptor.eventType === "tool_started" &&
      typeof payload["tool"] === "string"
    ) {
      started.set(payload["callId"], payload["tool"]);
    }
    if (record.payload.descriptor.eventType === "tool_completed") {
      completed.add(payload["callId"]);
    }
  }
  return [...started]
    .filter(([callId]) => !completed.has(callId))
    .map(([callId, tool]) => ({ callId, tool }));
}

function cancellationPartialForCall(
  records: DurableSemanticRecord[],
  callId: string,
): Json | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload;
    if (payload?.type !== "PullResolved" || payload.outcome.status !== "cancelled") {
      continue;
    }
    const request = pullRequest(records, payload.pullId);
    if (
      request?.descriptor.kind === "effect" &&
      request.descriptor.resolver.route === callId &&
      payload.outcome.partial !== undefined
    ) {
      return payload.outcome.partial;
    }
  }
  return undefined;
}

function previousToolStart(
  records: DurableSemanticRecord[],
  callId: string,
): Record<string, Json> | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]?.payload;
    if (payload?.type !== "DurableEmission" || payload.descriptor.eventType !== "tool_started") {
      continue;
    }
    const candidate = jsonRecord(payload.descriptor.payload);
    if (candidate?.["callId"] === callId) {
      return candidate;
    }
  }
  return undefined;
}

function pendingToolCallId(pending: PendingElicit): string | undefined {
  const context = jsonRecord(pending.descriptor.context);
  const nested = jsonRecord(context?.["context"]);
  return foreignCallId(context, nested);
}

function projectInterrupt(
  pending: NonNullable<ReturnType<typeof pendingElicit>>,
  params: ProgramRuntimeChatEngineParams,
): StreamEvent {
  const context = jsonRecord(pending.descriptor.context);
  const nested = jsonRecord(context?.["context"]);
  const callId = foreignCallId(context, nested);
  const elicitId = foreignElicitId(context, nested);
  const toolName =
    typeof context?.["foreignTool"] === "string"
      ? context["foreignTool"]
      : typeof nested?.["toolName"] === "string"
        ? nested["toolName"]
        : undefined;
  const publicKey =
    typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : pending.descriptor.key;
  return {
    type: "RUN_FINISHED",
    ...params.agUiRun,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: pending.pullId,
          reason: "input_required",
          message: pending.descriptor.message,
          responseSchema: schemaWithModelContext(context?.["responseSchema"], nested),
          ...(callId ? { toolCallId: callId } : {}),
          metadata: {
            "sweatpants/key": publicKey,
            ...(toolName ? { "sweatpants/toolName": toolName } : {}),
            ...(callId ? { callId } : {}),
            ...(elicitId ? { elicitId } : {}),
          },
        },
      ],
    },
  };
}

function foreignCallId(
  context: Record<string, Json> | undefined,
  nested: Record<string, Json> | undefined,
): string | undefined {
  if (typeof context?.["foreignRoute"] === "string") {
    return context["foreignRoute"];
  }
  return typeof nested?.["callId"] === "string" ? nested["callId"] : undefined;
}

function foreignElicitId(
  context: Record<string, Json> | undefined,
  nested: Record<string, Json> | undefined,
): string | undefined {
  if (typeof nested?.["elicitId"] === "string") {
    return nested["elicitId"];
  }
  return typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : undefined;
}

function toRuntimeMessage(value: Json): RuntimeMessage {
  const message = jsonRecord(value) ?? {};
  const role = message["role"];
  const content =
    typeof message["content"] === "string"
      ? message["content"]
      : JSON.stringify(message["content"] ?? null);
  if (role === "assistant") {
    const runtimeContent = Array.isArray(message["runtime_content"])
      ? message["runtime_content"].flatMap((block) => {
          const parsed = parseRuntimeContentBlock(block);
          return parsed ? [parsed] : [];
        })
      : undefined;
    const toolCalls = Array.isArray(message["tool_calls"])
      ? message["tool_calls"].flatMap((callValue) => {
          const call = jsonRecord(callValue);
          return call ? [call] : [];
        })
      : [];
    return {
      role: "assistant",
      content: runtimeContent ?? [
        ...(content ? [{ type: "text" as const, text: content }] : []),
        ...toolCalls.map((call) => {
          const fn = jsonRecord(call["function"]);
          return {
            type: "toolCall" as const,
            id: String(call["id"] ?? "tool"),
            name: String(call["target"] ?? call["name"] ?? fn?.["name"] ?? "tool"),
            arguments: toolCallArguments(call["input"] ?? call["arguments"] ?? fn?.["arguments"]),
            ...(typeof call["thoughtSignature"] === "string"
              ? { thoughtSignature: call["thoughtSignature"] }
              : {}),
          };
        }),
      ],
    };
  }
  if (role === "tool") {
    return {
      role: "toolResult",
      toolCallId: String(message["tool_call_id"] ?? "tool"),
      toolName: String(message["tool_name"] ?? "tool"),
      content: [{ type: "text", text: content }],
      isError: false,
    };
  }
  if (role === "system") {
    return { role: "system", content };
  }
  return { role: "user", content };
}

function parseRuntimeContentBlock(value: Json): ContentBlock | undefined {
  const block = jsonRecord(value);
  if (!block) {
    return undefined;
  }
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

function toolCallArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isUnknownRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isUnknownRecord(value) ? value : {};
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotAssistantContent(content: AssistantMessage["content"]): Json[] {
  return content.map((block) => {
    switch (block.type) {
      case "text":
        return assertJson({
          type: "text",
          text: block.text,
          ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}),
        });
      case "thinking":
        return assertJson({
          type: "thinking",
          text: block.text,
          ...(block.format !== undefined ? { format: block.format } : {}),
          ...(block.thinkingSignature !== undefined
            ? { thinkingSignature: block.thinkingSignature }
            : {}),
          ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        });
      case "toolCall":
        return assertJson({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          ...(block.thoughtSignature !== undefined
            ? { thoughtSignature: block.thoughtSignature }
            : {}),
        });
      case "image":
        return assertJson({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  });
}

function resolveOuterToolTarget(requested: string, tools: ReadonlyArray<{ name: string }>): string {
  if (tools.some((tool) => tool.name === requested)) {
    return requested;
  }
  const aliases = tools.filter((tool) => tool.name.startsWith(`${requested}_`));
  if (aliases.length === 1) {
    return aliases[0]!.name;
  }
  throw new CrankError("foreign_tool_not_found", `Tool not found: ${requested}`);
}

function sampleTools(tools: Json[]) {
  return tools.map((value) => {
    const tool = jsonRecord(value);
    if (!tool || typeof tool["name"] !== "string" || tool["name"].length === 0) {
      throw new CrankError("schema_validation_failed", "Sampling tool is invalid");
    }
    const parameters = jsonRecord(tool["inputSchema"]) ?? jsonRecord(tool["parameters"]);
    if (!parameters) {
      throw new CrankError("schema_validation_failed", "Sampling tool schema is invalid");
    }
    return {
      name: tool["name"],
      description: typeof tool["description"] === "string" ? tool["description"] : "",
      parameters,
    };
  });
}

function requireScopedForeignEffects(
  registrations: readonly [DurableEffectRegistration, DurableEffectRegistration] | undefined,
) {
  if (!registrations) {
    throw new CrankError(
      "foreign_driver_not_installed",
      "The recorded tool-session foreign driver is not installed",
    );
  }
  return registrations;
}

function requireToolRuntime(params: ProgramRuntimeChatEngineParams) {
  if (!params.toolRuntime) {
    throw new CrankError("tool_runtime_not_installed", "Tool runtime is not installed");
  }
  return params.toolRuntime;
}

function durableToolInput(call: ChatCall): Json {
  const input = jsonRecord(call.input);
  return input ? { ...input, toolCallId: call.id } : { input: call.input, toolCallId: call.id };
}

function jsonRecord(value: Json | undefined): Record<string, Json> | undefined {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function objectSchema(value: Json | undefined): Record<string, unknown> {
  return jsonRecord(value) ?? {};
}

function schemaWithModelContext(
  schema: Json | undefined,
  context: Record<string, Json> | undefined,
): Record<string, unknown> {
  const parsed = objectSchema(schema);
  if (!context) {
    return parsed;
  }
  const modelContext = Object.fromEntries(
    Object.entries(context).filter(
      ([key]) => key !== "callId" && key !== "elicitId" && key !== "toolName",
    ),
  );
  return Object.keys(modelContext).length > 0
    ? { ...parsed, "x-model-context": modelContext }
    : parsed;
}
