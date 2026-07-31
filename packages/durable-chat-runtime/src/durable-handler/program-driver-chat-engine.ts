import { type DurableEffectRegistration } from "@sweatpants/durable-effects";
import {
  assistantText,
  assistantToolCalls,
  createModelSamplingEffectRegistration,
} from "@sweatpants/model-sampling";

import { CrankError, PullApplicationError } from "@sweatpants/durable-execution";
import { resource, type Operation, type Stream } from "effection";
import { encodeElicitContext } from "@sweatpants/tool-session/elicit-context";
import {
  type DurableJournalAuthorityService,
  type DurableSemanticRecord,
} from "@sweatpants/journal-authority";
import { ProgramRuntime } from "@sweatpants/durable-execution";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import {
  assertReplayedCanonicalValue,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalProgramDriver,
  stableProgramAttachmentId,
  type DurableProgramContext,
  type DurableTool,
  type ProgramRunResult,
} from "@sweatpants/durable-execution";
import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  stableOpaqueId,
  type Json,
  type JsonObject,
} from "@sweatpants/foundation";
import { foreignToolAdapter, foreignToolAdapterChild } from "@sweatpants/tool-session/foreign";

import { createProgramDriverRegistry } from "@sweatpants/durable-execution";
import { runWithRenewedActivationLease } from "../host/activation-lease-coordinator.ts";
import { buildPluginReplayActivity } from "@sweatpants/chat-core";
import type { ChatSessionStreamEvent as StreamEvent } from "@sweatpants/chat-core";
import {
  nativeProgramIdentities,
  requiresFencedActivation,
  type ProgramDriverNativeToolComposition,
} from "../program-driver/native-tools.ts";
import type { ProgramDriverJournal, ProgramDriverJournalStore } from "./program-driver-journal.ts";
import { runLocalProgramActivation } from "./local-program-host.ts";
import { createToolRuntimeForeignEffectRegistrations } from "./program-driver-tool-runtime.ts";
import type { ElicitResponse, ProgramRuntimeChatEngineParams } from "./types.ts";
import { projectChatHistory } from "./model-sampling/history.ts";
import { createHostModelSamplingService } from "./model-sampling/service.ts";
import { runWithTurnEventWriter } from "./model-sampling/turn-event-api.ts";

type ChatCall = {
  id: string;
  target: string;
  input: Json;
  thoughtSignature?: string;
};

type ProgramDriverChatEngineParams = ProgramRuntimeChatEngineParams & {
  journalStore: ProgramDriverJournalStore;
  foreignEffects?: readonly [DurableEffectRegistration, DurableEffectRegistration];
  nativeTools?: ProgramDriverNativeToolComposition;
  continueAfterCancellation?: boolean;
  /** Host-owned delivery projection invoked only inside the active crank turn. */
  liveEvent?: (event: StreamEvent) => Operation<void>;
};

import {
  manifest,
  modelSample,
  type ChatProgramInput,
  type ChatToolCatalog,
  type ChatToolCatalogEntry,
} from "./program-driver-schema.ts";

const rootTool = createPinnedDurableProgram(manifest, function* (input, context) {
  const messages = [...input.messages];
  const hasPriorAssistantOrTool = messages.some(
    (message) => message.role === "assistant" || message.role === "tool",
  );
  const completedCallIds = new Set<string>();
  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sampled = yield* context.effect(
      modelSample,
      {
        invocation: {
          context: {
            messages,
            ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
          },
          ...(iteration === 0 && !hasPriorAssistantOrTool && input.toolChoice !== undefined
            ? { options: { toolChoice: input.toolChoice } }
            : {}),
        },
        tools: { type: "catalog", digest: input.catalog.digest },
        response: { type: "message" },
        classifications: [],
      },
      { audience: "model-runtime" },
    );
    const text = assistantText(sampled.message);
    const calls: ChatCall[] = assistantToolCalls(sampled.message)
      .filter((call) => !completedCallIds.has(call.id))
      .map((call) => ({
        id: call.id,
        target: resolveOuterToolTarget(
          call.function.name,
          Object.keys(input.catalog.entries).map((name) => ({ name })),
        ),
        input: call.function.arguments,
        ...(call.thoughtSignature !== undefined ? { thoughtSignature: call.thoughtSignature } : {}),
      }));
    if (calls.length === 0) {
      yield* context.emit("assistant_text", { text });
      return text;
    }
    for (const call of calls) {
      completedCallIds.add(call.id);
    }
    messages.push({ role: "assistant", content: sampled.message.content });
    for (const call of calls) {
      yield* context.emit("tool_started", {
        callId: call.id,
        tool: call.target,
        input: call.input,
      });
      const catalogEntry = input.catalog.entries[call.target];
      if (!catalogEntry) {
        throw new CrankError("foreign_tool_not_found", `Tool not found: ${call.target}`);
      }
      const outcome = yield* invokeCatalogTool(context, catalogEntry.execution, call);
      yield* context.emit("tool_completed", {
        callId: call.id,
        tool: call.target,
        result: outcome.result,
        failed: outcome.failed,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.target,
        content: JSON.stringify(outcome.result),
        isError: outcome.failed,
      });
    }
  }
  throw new CrankError("max_tool_iterations", "Maximum tool iterations reached");
});

type CatalogToolCall = ChatCall;

/**
 * Failures that mean "the foreign process is gone or unreachable".
 *
 * These are outside the durable program's control: a non-journal-native tool
 * holds its continuation in its own process, and that process may vanish
 * between an elicitation and the human's answer. No amount of replay revives
 * it, so the conversation is told what happened and decides what to do next.
 *
 * `effect_outcome_indeterminate` is the authority's own verdict when a host
 * died with an unsafe attempt in flight: the call may or may not have landed,
 * and nobody can find out. That is the same class of fact.
 *
 * Everything else stays fatal on purpose — cancellation must keep unwinding,
 * and contract violations such as parameter validation must surface as run
 * errors rather than being narrated to the model as ordinary results.
 */
const RECOVERABLE_FOREIGN_FAILURES: ReadonlySet<string> = new Set([
  "foreign_session_ended",
  "foreign_tool_start_failed",
  "effect_outcome_indeterminate",
]);

/**
 * Runs one catalog tool call and converts an application-level failure into an
 * ordinary tool result.
 *
 * A foreign tool is not journal-native: its process may vanish between an
 * elicitation and the human's answer, and no amount of durable replay can
 * revive it. When that happens the adapter reports a typed failure and the
 * authority journals it. That is information the conversation can act on — the
 * model may restart the flow now that the human is engaged — not a reason to
 * destroy the turn.
 *
 * The substituted result is derived from the journaled error, so replay
 * reproduces it exactly. Cancellation and `CrankError` still propagate: durable
 * unwinding and authored contract violations must remain fatal.
 */
function* invokeCatalogTool(
  context: DurableProgramContext,
  entry: ChatToolCatalogEntry["execution"],
  call: CatalogToolCall,
): Operation<{ result: Json; failed: boolean }> {
  try {
    const result =
      entry.kind === "program"
        ? yield* context.invoke<Json>({ ...entry.program, input: durableToolInput(call) })
        : yield* context.foreignTool<Json>({
            driver: entry.driver,
            tool: entry.tool,
            input: call.input,
            durability: entry.durability,
            route: call.id,
          });
    return { result, failed: false };
  } catch (error) {
    if (!(error instanceof PullApplicationError)) {
      throw error;
    }
    const { code, message, details } = error.applicationError;
    if (!RECOVERABLE_FOREIGN_FAILURES.has(code)) {
      throw error;
    }
    return {
      result: {
        status: "error",
        error: { code, message, ...(details === undefined ? {} : { details }) },
      },
      failed: true,
    };
  }
}

/** Runs one HTTP chat activation through the crank-native ProgramRuntime. */
export function createProgramDriverChatEngine(
  params: ProgramDriverChatEngineParams,
): Stream<StreamEvent, void> {
  return resource(function* (provide) {
    let events: StreamEvent[] | undefined;
    let cursor = 0;
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        events ??= yield* runWithTurnEventWriter(
          params.liveEvent ? { emit: params.liveEvent } : undefined,
          () => activateProgramDriverChatEngine(params),
        );
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
  const recovery = yield* journal.recoveryState(params.conversationId);
  const active =
    recovery.status === "active"
      ? { taskId: recovery.taskId, turnId: recovery.turnId, input: recovery.input }
      : undefined;
  const turnNumber = yield* journal.rootTaskCount(params.conversationId);
  const taskId = active?.taskId ?? `turn-${turnNumber}/root`;
  const turnId = active?.turnId ?? `turn-${turnNumber}`;
  let before = yield* journal.readJournal(params.conversationId, taskId);
  const foreignDriver = scopedForeignEffects ? "tool-session" : "chat-tool-runtime";
  const requestedInput: ChatProgramInput = {
    messages: projectChatHistory(params.messages),
    maxIterations: params.maxIterations,
    catalog: createChatToolCatalog(params, foreignDriver),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.initialToolChoice !== undefined ? { toolChoice: params.initialToolChoice } : {}),
  };
  // Replay of the accepted canonical input never reruns schema code (DR-023).
  const replacementQueued =
    active !== undefined && canonicalJson(active.input) !== canonicalJson(requestedInput);
  const input = active
    ? assertReplayedCanonicalValue<ChatProgramInput>(active.input)
    : requestedInput;
  const attach = {
    sessionId: params.conversationId,
    taskId,
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input,
    route: { driverKind: "program" },
    executionEpoch: 1,
    affinity: { kind: "conversation" as const, key: params.conversationId },
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
      const raced = yield* journal.recoveryState(params.conversationId);
      if (
        raced.status !== "active" ||
        raced.taskId !== taskId ||
        canonicalJson(raced.input) !== canonicalJson(input)
      ) {
        throw new CrankError("idempotency_conflict", "Concurrent root task input differs");
      }
    }
    before = yield* journal.readJournal(params.conversationId, taskId);
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
    [
      "program",
      createLocalProgramDriver(tools, {
        foreignToolChild: foreignToolAdapterChild,
        ...(params.nativeTools?.setup ? { setup: params.nativeTools.setup } : {}),
      }),
    ],
    ...(params.nativeTools?.drivers ?? []),
  ]);
  let streamedTerminal = false;
  const boundForeignDriver = Object.values(input.catalog.entries).find(
    (
      entry,
    ): entry is ChatToolCatalogEntry & {
      execution: Extract<ChatToolCatalogEntry["execution"], { kind: "foreign-tool" }>;
    } => entry.execution.kind === "foreign-tool",
  )?.execution.driver;
  const foreignEffects =
    boundForeignDriver === "tool-session"
      ? requireScopedForeignEffects(scopedForeignEffects)
      : boundForeignDriver === "chat-tool-runtime"
        ? createToolRuntimeForeignEffectRegistrations({
            runtime: requireToolRuntime(params),
            entries: params.toolInventoryEntries ?? [],
            threadId: params.agUiRun.threadId,
            runId: params.agUiRun.runId,
          })
        : [];
  const modelSamplingService = createHostModelSamplingService({
    model: params.model,
    ...(params.streamOptions ? { streamOptions: params.streamOptions } : {}),
    catalog: input.catalog,
    ...(params.historyPolicy ? { historyPolicy: params.historyPolicy } : {}),
    onTerminalStreamed() {
      streamedTerminal = true;
    },
  });
  const effects = createDurableEffectRegistry(
    [
      createModelSamplingEffectRegistration(),
      ...foreignEffects,
      ...(params.nativeTools?.effects ?? []),
    ],
    Object.values(manifest.effects),
  );
  const outcome = yield* runLocalProgramActivation(
    {
      authority: journal.authority,
      drivers,
      effects,
      modelSamplingService,
      routeResolver: function* (program, parentRoute) {
        const binding = [...(params.nativeTools?.bindings.values() ?? [])].find(
          (candidate) =>
            candidate.tool.manifest.programId === program.id &&
            candidate.tool.manifest.version === program.version &&
            candidate.tool.manifest.digest === program.digest,
        );
        return binding?.route ?? parentRoute;
      },
    },
    function* () {
      return yield* runFencedActivation(
        journal.authority,
        params.conversationId,
        attach.executionEpoch,
        requiresFencedActivation(params.nativeTools),
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
  const after = yield* journal.readJournal(params.conversationId, taskId);
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
    yield* params.publishTerminal({
      outcome: outcome.value,
      disposition: "completed",
      events,
    });
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
    if (params.continueAfterCancellation || replacementQueued) {
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
      yield* params.publishTerminal({
        outcome: {
          code: "PROGRAM_CANCELLED",
          message: params.pluginAbort?.reason ?? "Program was cancelled",
        },
        disposition: "cancelled",
        events,
      });
    }
  } else {
    events.push({ type: "RUN_ERROR", code: outcome.error.code, message: outcome.error.message });
    yield* params.publishTerminal({
      outcome: assertJson(outcome.error),
      disposition: "failed",
      events,
    });
  }

  return events;
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
      outcome: { status: "ok", value: assertJson(response.completion) },
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
        ...(payload["failed"] === true ? { isError: true } : {}),
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
        isError: true,
      });
    }
  }
  const errored = [...records]
    .reverse()
    .find(
      (record) => record.payload.type === "TaskClosed" && record.payload.outcome.status === "error",
    );
  if (errored?.payload.type === "TaskClosed" && errored.payload.outcome.status === "error") {
    for (const pending of unfinishedToolCalls(allRecords)) {
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: "TOOL_CALL_END", toolCallId: pending.callId });
      }
      events.push({
        type: "TOOL_CALL_RESULT",
        messageId: `tool:${pending.callId}:error`,
        toolCallId: pending.callId,
        toolCallName: pending.tool,
        content: JSON.stringify({ status: "error", error: errored.payload.outcome.error }),
        role: "tool",
        isError: true,
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

let activationOwnerCounter = 0;

/** Fences only deployments whose native bindings declare fenced activation. */
function* runFencedActivation(
  authority: DurableJournalAuthorityService,
  sessionId: string,
  fallbackEpoch: number,
  fenced: boolean,
  activate: (epoch: number, ownerId?: string) => Operation<ProgramRunResult>,
): Operation<ProgramRunResult> {
  if (!fenced) {
    return yield* activate(fallbackEpoch);
  }
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
  if (aliases.length > 1) {
    throw new CrankError(
      "ambiguous_tool_alias",
      `Tool name "${requested}" matches multiple catalog entries: ${aliases
        .map((tool) => tool.name)
        .join(", ")}`,
    );
  }
  // Preserve the provider's requested target so the root program can emit a
  // normal tool_started record before rejecting it at the bound catalog. That
  // produces a causal call/error-result pair for follow-up history.
  return requested;
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

function createChatToolCatalog(
  params: ProgramDriverChatEngineParams,
  foreignDriver: "tool-session" | "chat-tool-runtime",
): ChatToolCatalog {
  const nativePrograms = nativeProgramIdentities(params.nativeTools);
  const entries: Record<string, ChatToolCatalogEntry> = {};
  for (const tool of [...params.toolSchemas].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const program = nativePrograms[tool.name];
    entries[tool.name] = {
      model: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
      execution: program
        ? { kind: "program", target: tool.name, program }
        : {
            kind: "foreign-tool",
            target: tool.name,
            driver: foreignDriver,
            tool: tool.name,
            durability: "ephemeral_handle",
          },
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
  // Narrowing the already-parsed `Json` union is the compiler's job, not a parser's.
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function objectSchema(value: Json | undefined): JsonObject {
  return jsonRecord(value) ?? {};
}

function schemaWithModelContext(
  schema: Json | undefined,
  context: Record<string, Json> | undefined,
): JsonObject {
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
    ? { ...parsed, "x-elicit-context": modelContext }
    : parsed;
}
