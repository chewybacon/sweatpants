import { resource, type Operation, type Stream } from "effection";
import { encodeElicitContext } from "@sweatpants/elicit-context";
import {
  CrankError,
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  MODEL_SAMPLE_EFFECT,
  MODEL_SAMPLE_SCHEMA_ENTRIES,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  assertJson,
  assertReplayedCanonicalValue,
  canonicalJson,
  canonicalSnapshot,
  createPortableSchemaDescriptor,
  standardSchemaOf,
  createDurableEffectRegistration,
  createDurableEffectRegistry,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  defineDurableProgramManifest,
  foreignToolAdapter,
  stableOpaqueId,
  stableProgramAttachmentId,
  type DurableEffectRegistration,
  type DurableJournalAuthorityService,
  type DurableSchemaRegistryEntry,
  type DurableSemanticRecord,
  type DurableTool,
  type Json,
  type ModelSampleCall,
  type ModelSampleRequest,
  type ModelSampleResult,
  type ProgramRunResult,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "@sweatpants/session-contract";

import type {
  AssistantMessage,
  ContentBlock,
  Context as RuntimeContext,
  Message as RuntimeMessage,
} from "../../lib/chat/runtime/index.ts";
import { runWithRenewedActivationLease } from "../activation-lease-coordinator.ts";
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

type ChatCall = ModelSampleCall;
type ChatSampleRequest = ModelSampleRequest;
type ChatSampleResult = ModelSampleResult;

type ThinCatalogEntry =
  | { kind: "program"; target: string; program: NativeProgramIdentity }
  | {
      kind: "foreign-tool";
      target: string;
      driver: "tool-session" | "framework-tool-runtime";
      tool: string;
      durability: "ephemeral_handle";
    };

type ThinProgramCatalog = {
  version: 1;
  digest: string;
  entries: Record<string, ThinCatalogEntry>;
};

type ChatProgramInput = ChatSampleRequest & {
  maxIterations: number;
  catalog: ThinProgramCatalog;
};

type ProgramDriverChatEngineParams = ProgramRuntimeChatEngineParams & {
  journalStore: ProgramDriverJournalStore;
  foreignEffects?: readonly [DurableEffectRegistration, DurableEffectRegistration];
  nativeTools?: ProgramDriverNativeToolComposition;
  continueAfterCancellation?: boolean;
  /** Host-owned delivery projection invoked only inside the active crank turn. */
  liveEvent?: (event: StreamEvent) => Operation<void>;
};

const chatEngineSchemaEntries: DurableSchemaRegistryEntry[] = [];

function chatEngineSchema(
  identity: string,
  role: PortableSchemaRole,
  projection: Json,
  guard: (value: unknown) => string | undefined,
): PortableSchemaDescriptor {
  const descriptor = createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
  chatEngineSchemaEntries.push({
    descriptor,
    schema: standardSchemaOf("sweatpants", (value) => {
      const message = guard(value);
      if (message !== undefined) {
        return { issues: [{ message }] };
      }
      try {
        return { value: assertJson(value) };
      } catch {
        return { issues: [{ message: "value must be canonical JSON" }] };
      }
    }),
  });
  return descriptor;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const modelSample = MODEL_SAMPLE_EFFECT;

const chatRootInputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/input",
  "program_input",
  {
    type: "object",
    required: ["messages", "maxIterations", "catalog"],
    properties: {
      messages: { type: "array", items: true },
      systemPrompt: { type: "string" },
      toolChoice: { enum: ["auto", "none", "required"] },
      maxIterations: { type: "integer", minimum: 1, maximum: 100 },
      catalog: {
        type: "object",
        required: ["version", "digest", "entries"],
        properties: {
          version: { const: 1 },
          digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
          entries: { type: "object", additionalProperties: true },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  (value) => {
    if (!isJsonObject(value) || !Array.isArray(value["messages"])) {
      return "chat program input requires messages";
    }
    if (
      !Number.isSafeInteger(value["maxIterations"]) ||
      (value["maxIterations"] as number) < 1 ||
      (value["maxIterations"] as number) > 100
    ) {
      return "maxIterations must be an integer between 1 and 100";
    }
    if (
      value["toolChoice"] !== undefined &&
      !["auto", "none", "required"].includes(String(value["toolChoice"]))
    ) {
      return "toolChoice is invalid";
    }
    const catalog = value["catalog"];
    if (!isJsonObject(catalog) || catalog["version"] !== 1 || !isJsonObject(catalog["entries"])) {
      return "catalog must be a versioned entry map";
    }
    if (catalog["digest"] !== canonicalSnapshot({ version: 1, entries: catalog["entries"] }).sha) {
      return "catalog digest differs from entries";
    }
    const allowed = new Set(["messages", "systemPrompt", "toolChoice", "maxIterations", "catalog"]);
    if (!Object.keys(value).every((key) => allowed.has(key))) {
      return "chat program input has unexpected keys";
    }
    return undefined;
  },
);

const chatRootOutputDescriptor = chatEngineSchema(
  "sweatpants.chat-root/output",
  "program_output",
  { type: "string" },
  (value) => (typeof value === "string" ? undefined : "chat program output must be a string"),
);

const manifest = defineDurableProgramManifest<ChatProgramInput, string>({
  programId: "sweatpants.chat-root",
  version: "1.2.0",
  digest: "cd46d11a63f7e556a52b9fc467253bf8b557aa35ac923b8700d2dae557064985",
  inputSchema: chatRootInputDescriptor,
  outputSchema: chatRootOutputDescriptor,
  elicits: {},
  effects: { [modelSample.name]: modelSample },
  capabilities: { durableEmissions: true, structuredChildren: true, replay: "strict" },
});

/**
 * Digest-keyed validator entries for the built-in chat-root program and its
 * model-sampling effect. Deployments merge these with their generated tool
 * catalogs into the journal authority's schema registry.
 */
export function programDriverChatEngineSchemaEntries(): readonly DurableSchemaRegistryEntry[] {
  return [...MODEL_SAMPLE_SCHEMA_ENTRIES, ...chatEngineSchemaEntries];
}

const rootTool = createPinnedDurableProgram(manifest, function* (input, context) {
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
      const catalogEntry = input.catalog.entries[call.target];
      if (!catalogEntry) {
        throw new CrankError("unknown_target", `Tool ${call.target} is outside the bound catalog`);
      }
      const result =
        catalogEntry.kind === "program"
          ? yield* context.invoke<Json>({
              ...catalogEntry.program,
              input: durableToolInput(call),
            })
          : yield* context.foreignTool<Json>({
              driver: catalogEntry.driver,
              tool: catalogEntry.tool,
              input: call.input,
              durability: catalogEntry.durability,
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
        if (!event) return { done: true, value: undefined };
        cursor += 1;
        return { done: false, value: event };
      },
    });
  });
}

function* activateProgramDriverChatEngine(
  params: ProgramDriverChatEngineParams,
): Operation<StreamEvent[]> {
  const liveEvent = params.liveEvent;
  const journal = yield* params.journalStore.open(params.conversationId);
  const scopedForeignEffects = params.foreignEffects;
  let before = yield* journal.readJournal(params.conversationId);
  const active = activeRoot(before);
  const turnNumber = rootTaskCount(before);
  const taskId = active?.taskId ?? `turn-${turnNumber}/root`;
  const turnId = active?.turnId ?? `turn-${turnNumber}`;
  const foreignDriver = scopedForeignEffects ? "tool-session" : "framework-tool-runtime";
  const requestedInput: ChatProgramInput = {
    messages: params.messages.map((message) => assertJson(message)),
    maxIterations: params.maxIterations,
    catalog: createThinCatalog(params, foreignDriver),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.initialToolChoice !== undefined ? { toolChoice: params.initialToolChoice } : {}),
  };
  // Replay of the accepted canonical input never reruns schema code (DR-023).
  const input = active
    ? assertReplayedCanonicalValue<ChatProgramInput>(active.input)
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
  let streamedTerminal = false;
  const boundForeignDriver = Object.values(input.catalog.entries).find(
    (entry): entry is Extract<ThinCatalogEntry, { kind: "foreign-tool" }> =>
      entry.kind === "foreign-tool",
  )?.driver;
  const foreignEffects =
    boundForeignDriver === "tool-session"
      ? requireScopedForeignEffects(scopedForeignEffects)
      : boundForeignDriver === "framework-tool-runtime"
        ? createToolRuntimeForeignEffectRegistrations({
            runtime: requireToolRuntime(params),
            entries: params.toolInventoryEntries ?? [],
            threadId: params.agUiRun.threadId,
            runId: params.agUiRun.runId,
          })
        : [];
  const effects = createDurableEffectRegistry(
    [
      createDurableEffectRegistration(
        modelSample,
        { mode: "idempotent", mechanism: "pull_id_key" },
        function* (request, context) {
          let partialText = "";
          let streamStarted = false;
          const messageId = `assistant:stream:${taskId}:${context.pullId}`;
          try {
            const value = yield* sampleModel(
              params,
              request,
              context.cancellation,
              context.pullId,
              function* (text, delta) {
                partialText = text.slice(-32_768);
                if (!liveEvent) return;
                if (!streamStarted) {
                  streamStarted = true;
                  yield* liveEvent({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
                }
                yield* liveEvent({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
              },
            );
            if (streamStarted && liveEvent) {
              yield* liveEvent({ type: "TEXT_MESSAGE_END", messageId });
              if (value.calls.length === 0) streamedTerminal = true;
            }
            return { status: "ok" as const, value };
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
    ],
    Object.values(manifest.effects),
  );
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
            const agentCorePlaced = [...(params.nativeTools?.bindings.values() ?? [])].some(
              (binding) => isAgentCoreRoute(binding.route),
            );
            return yield* runFencedActivation(
              journal.authority,
              params.conversationId,
              attach.executionEpoch,
              agentCorePlaced,
              function* (executionEpoch, activationOwnerId) {
                return yield* ProgramRuntime.operations.run({
                  attach: { ...attach, executionEpoch },
                  executeHostEffects: true,
                  ...(activationOwnerId ? { activationOwnerId } : {}),
                });
              },
            );
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
  const projected = projectRecords(after.slice(before.length), after);
  events.push(
    ...(streamedTerminal
      ? projected.filter(
          (event) =>
            event.type !== "TEXT_MESSAGE_START" &&
            event.type !== "TEXT_MESSAGE_CONTENT" &&
            event.type !== "TEXT_MESSAGE_END",
        )
      : projected),
  );
  if (outcome.state === "completed") {
    events.push({ type: "RUN_FINISHED", ...params.agUiRun, outcome: { type: "success" } });
  } else if (outcome.state === "parked") {
    const pending = pendingElicit(after, outcome.pullId);
    if (pending) {
      const pendingCallId = pendingToolCallId(after, pending);
      if (pendingCallId) {
        events.push({ type: "TOOL_CALL_END", toolCallId: pendingCallId });
      }
      events.push(projectInterrupt(after, pending, params));
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
  onText?: (text: string, delta: string) => Operation<void>,
): Operation<ChatSampleResult> {
  const foreignSamplingRequest =
    request.maxTokens !== undefined ||
    request.modelPreferences !== undefined ||
    request.tools !== undefined ||
    request.schema !== undefined;
  const runtimeContext: RuntimeContext = {
    ...(request.systemPrompt !== undefined
      ? { systemPrompt: modelSystemPromptText(request.systemPrompt) }
      : {}),
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
      if (onText) yield* onText(text, next.value.delta);
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
      const providerMessage = safeProviderErrorMessage(next.value.error.errorMessage);
      throw new CrankError(
        "model_runtime_failed",
        providerMessage ? `Model runtime failed: ${providerMessage}` : "Model runtime failed",
      );
    }
  }
}

function safeProviderErrorMessage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll(/(bearer|token|api[-_ ]?key)\s*[:=]?\s*[^\s,;]+/gi, "$1 [redacted]")
    .trim()
    .slice(0, 512);
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
    const correlation = pendingCorrelation(records, {
      ...payload,
      descriptor: payload.descriptor,
    });
    if (
      correlation.callId === response.callId &&
      (correlation.elicitId === response.elicitId || payload.pullId === response.elicitId)
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

function pendingToolCallId(
  records: DurableSemanticRecord[],
  pending: PendingElicit,
): string | undefined {
  return pendingCorrelation(records, pending).callId;
}

function projectInterrupt(
  records: DurableSemanticRecord[],
  pending: NonNullable<ReturnType<typeof pendingElicit>>,
  params: ProgramRuntimeChatEngineParams,
): StreamEvent {
  const context = jsonRecord(pending.descriptor.context);
  const nested = jsonRecord(context?.["context"]);
  const correlation = pendingCorrelation(records, pending);
  const isForeign = typeof context?.["foreignTool"] === "string";
  const authoredContext = isForeign ? nested : context;
  const responseProjection = isForeign
    ? context?.["responseSchema"]
    : pending.descriptor.response.inputProjection;
  const encoded = isForeign
    ? {
        // Preserve the established foreign ToolSession projection contract;
        // native durable definitions below use the canonical x-elicit seam.
        message: pending.descriptor.message,
        schema: schemaWithModelContext(responseProjection, authoredContext),
      }
    : authoredContext
      ? encodeElicitContext(
          pending.descriptor.message,
          authoredContext,
          objectSchema(responseProjection),
        )
      : { message: pending.descriptor.message, schema: objectSchema(responseProjection) };
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
          message: encoded.message,
          responseSchema: encoded.schema,
          ...(correlation.callId ? { toolCallId: correlation.callId } : {}),
          metadata: {
            "sweatpants/key": publicKey,
            ...(correlation.toolName ? { "sweatpants/toolName": correlation.toolName } : {}),
            ...(correlation.callId ? { callId: correlation.callId } : {}),
            ...(correlation.elicitId ? { elicitId: correlation.elicitId } : {}),
          },
        },
      ],
    },
  };
}

function pendingCorrelation(
  records: DurableSemanticRecord[],
  pending: PendingElicit,
): { callId?: string; elicitId?: string; toolName?: string } {
  const context = jsonRecord(pending.descriptor.context);
  const nested = jsonRecord(context?.["context"]);
  const foreignId = foreignCallId(context, nested);
  const foreignTool =
    typeof context?.["foreignTool"] === "string"
      ? context["foreignTool"]
      : typeof nested?.["toolName"] === "string"
        ? nested["toolName"]
        : undefined;
  if (foreignId || foreignTool) {
    const elicitId = foreignElicitId(context, nested);
    return {
      ...(foreignId ? { callId: foreignId } : {}),
      ...(elicitId ? { elicitId } : {}),
      ...(foreignTool ? { toolName: foreignTool } : {}),
    };
  }

  // Native durable child context is the authored value only. Correlation stays
  // private by deriving the child invocation from TaskOpened.parentPullId and
  // the immediately preceding root `tool_started` emission.
  const opened = records.find(
    (record) => record.payload.type === "TaskOpened" && record.payload.taskId === pending.taskId,
  );
  if (opened?.payload.type !== "TaskOpened" || !opened.payload.parentPullId) {
    return { elicitId: pending.pullId };
  }
  const parentPullId = opened.payload.parentPullId;
  const parentPullIndex = records.findIndex(
    (record) => record.payload.type === "PullRequested" && record.payload.pullId === parentPullId,
  );
  const parentTaskId = opened.payload.parentTaskId;
  for (let index = parentPullIndex - 1; index >= 0; index -= 1) {
    const candidate = records[index]?.payload;
    if (
      candidate?.type !== "DurableEmission" ||
      candidate.taskId !== parentTaskId ||
      candidate.descriptor.eventType !== "tool_started"
    ) {
      continue;
    }
    const payload = jsonRecord(candidate.descriptor.payload);
    if (typeof payload?.["callId"] === "string" && typeof payload["tool"] === "string") {
      return {
        callId: payload["callId"],
        elicitId: pending.pullId,
        toolName: payload["tool"],
      };
    }
  }
  return { elicitId: pending.pullId };
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

function modelSystemPromptText(value: Json): string {
  if (typeof value === "string") return value;
  const part = jsonRecord(value);
  return typeof part?.["value"] === "string"
    ? part["value"]
    : JSON.stringify(part?.["value"] ?? value);
}

function toRuntimeMessage(value: Json): RuntimeMessage {
  const message = jsonRecord(value) ?? {};
  const role = message["role"];
  const parts = Array.isArray(message["parts"]) ? message["parts"] : undefined;
  const partContent = parts
    ?.map((partValue) => {
      const part = jsonRecord(partValue);
      const content = part?.["value"];
      return typeof content === "string" ? content : JSON.stringify(content ?? null);
    })
    .join("");
  const content =
    partContent ??
    (typeof message["content"] === "string"
      ? message["content"]
      : JSON.stringify(message["content"] ?? null));
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

let activationOwnerCounter = 0;

function isAgentCoreRoute(route: Json): boolean {
  return Boolean(
    route &&
    typeof route === "object" &&
    !Array.isArray(route) &&
    route["driverKind"] === "agentcore",
  );
}

/** Fences only deployments that actually install an AgentCore native driver. */
function* runFencedActivation(
  authority: DurableJournalAuthorityService,
  sessionId: string,
  fallbackEpoch: number,
  fenced: boolean,
  activate: (epoch: number, ownerId?: string) => Operation<ProgramRunResult>,
): Operation<ProgramRunResult> {
  if (!fenced) return yield* activate(fallbackEpoch);
  activationOwnerCounter += 1;
  const ownerId = stableOpaqueId("host-activation", [
    process.pid,
    Date.now(),
    activationOwnerCounter,
  ]);
  return yield* runWithRenewedActivationLease(
    authority,
    sessionId,
    ownerId,
    (epoch, currentOwnerId) => activate(epoch, currentOwnerId),
  );
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

function createThinCatalog(
  params: ProgramDriverChatEngineParams,
  foreignDriver: "tool-session" | "framework-tool-runtime",
): ThinProgramCatalog {
  const nativePrograms = nativeProgramIdentities(params.nativeTools);
  const entries: Record<string, ThinCatalogEntry> = {};
  for (const tool of [...params.toolSchemas].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const program = nativePrograms[tool.name];
    entries[tool.name] = program
      ? { kind: "program", target: tool.name, program }
      : {
          kind: "foreign-tool",
          target: tool.name,
          driver: foreignDriver,
          tool: tool.name,
          durability: "ephemeral_handle",
        };
  }
  return {
    version: 1,
    digest: canonicalSnapshot({ version: 1, entries }).sha,
    entries,
  };
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
