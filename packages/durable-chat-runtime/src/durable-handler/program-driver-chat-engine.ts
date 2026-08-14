import { EventType, type AGUIEvent } from "@ag-ui/core";
import type {
  DurableEffectOutcomeAcknowledgement,
  DurableEffectRegistration,
} from "@sweatpants/durable-effects";
import {
  assistantText,
  assistantToolCalls,
  createModelSamplingEffectRegistration,
  sampleDurableModel,
  type ModelSampleRequest,
  ExecutionModelSamplingServiceContext,
  MODEL_SAMPLE_EFFECT,
} from "@sweatpants/model-sampling";

import { resource, type Operation, type Stream } from "effection";
import type {
  DurableJournalAuthorityService,
  DurableSemanticRecord,
} from "@sweatpants/journal-authority";
import { createDurableEffectRegistry } from "@sweatpants/durable-effects/runtime";
import {
  CrankError,
  PullApplicationError,
  ProgramRuntime,
  assertReplayedCanonicalValue,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createLocalProgramDriver,
  createProgramDriverRegistry,
  stableProgramAttachmentId,
  type DurableProgramContext,
  type ProgramRunResult,
} from "@sweatpants/durable-execution";
import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  stableTupleHash,
  type Json,
  type JsonObject,
} from "@sweatpants/foundation";
import { foreignToolAdapter, foreignToolAdapterChild } from "@sweatpants/tool-session/foreign";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { computeClientElicitBindingId } from "@sweatpants/tool-session/mcp";
import { type ChatMessage } from "@sweatpants/chat-contract";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  decodeChatHistoryEntries,
  type ConversationStreamEvent,
} from "@sweatpants/chat-core";

import { runWithRenewedActivationLease } from "../host/activation-lease-coordinator.ts";
import type {
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  PublicActivityNode,
  PublicGenericActivityNode,
} from "@sweatpants/chat-core";

type StreamEvent = ConversationStreamEvent;
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
import { encodeChatHistoryEntriesForProgramInput } from "./program-driver-history.ts";
import { createHostModelSamplingService } from "./model-sampling/service.ts";
import { runWithTurnEventWriter } from "./model-sampling/turn-event-api.ts";

type TreePlacement = {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly sequence: number;
};

type RecursiveExecutionNode = {
  readonly type: "execution";
  readonly placement: TreePlacement;
  readonly executionId: string;
  readonly presentation: "public" | "opaque";
  readonly status: "running" | "complete" | "error" | "cancelled";
  readonly children: readonly never[];
};

type ChatCall = {
  id: string;
  target: string;
  input: Json;
  thoughtSignature: string | null;
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

// Root tool owns the deterministic sample/tool loop and its durable continuation semantics.
// fallow-ignore-next-line complexity
const rootTool = createPinnedDurableProgram(manifest, function* (input, context) {
  const historyEntries = decodeChatHistoryEntries(input.messages, "$.messages");
  const messages: ChatMessage[] = projectChatHistory(historyEntries);
  const hasPriorAssistantOrTool = messages.some(
    (message) => message.role === "assistant" || message.role === "tool",
  );
  const completedCallIds = new Set<string>();
  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sampleRequest: ModelSampleRequest = {
      invocation: {
        context: {
          messages: [
            ...(input.systemPrompt
              ? [{ role: "system" as const, content: input.systemPrompt }]
              : []),
            ...messages,
          ],
          tools: [],
        },
        ...(iteration === 0 && !hasPriorAssistantOrTool && input.toolChoice !== undefined
          ? { options: { toolChoice: input.toolChoice } }
          : {}),
      },
      tools: {
        type: "embedded",
        tools: Object.values(input.catalog.entries).map((entry) => entry.model),
      },
      response: { type: "message" },
    };
    const sampled = yield* sampleDurableModel(context, sampleRequest, {
      audience: "model-runtime",
    });
    const text = assistantText(sampled.message);
    const calls: ChatCall[] = assistantToolCalls(sampled.message)
      .filter((call) => !completedCallIds.has(call.id))
      .map((call) => ({
        id: call.id,
        target: resolveOuterToolTarget(
          call.name,
          Object.keys(input.catalog.entries).map((name) => ({ name })),
        ),
        input: call.input,
        thoughtSignature: call.thoughtSignature,
      }));
    if (calls.length === 0) {
      yield* context.emit("assistant_text", { text });
      return text;
    }
    for (const call of calls) {
      completedCallIds.add(call.id);
    }
    messages.push(sampled.message.message);
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
        toolCallId: call.id,
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
        ? yield* context.invoke({ ...entry.program, input: durableToolInput(call) })
        : yield* context.foreignTool({
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
    let failure: Error | undefined;
    try {
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
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      params.onLiveActivationSettled?.(failure);
    }
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
    messages: encodeChatHistoryEntriesForProgramInput(params.messages),
    maxIterations: params.maxIterations,
    catalog: createChatToolCatalog(params, foreignDriver),
    ...(params.systemPrompt !== undefined ? { systemPrompt: params.systemPrompt } : {}),
    ...(params.initialToolChoice !== undefined ? { toolChoice: params.initialToolChoice } : {}),
  };
  // Replay of the accepted canonical input never reruns schema code (DR-023).
  const replacementQueued =
    active !== undefined &&
    params.pluginAbort === undefined &&
    params.recoveryOnly !== true &&
    (params.elicitResponses?.length ?? 0) === 0 &&
    canonicalJson(active.input) !== canonicalJson(requestedInput);
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
  params.onLiveTaskReady?.(taskId);

  if (active && (params.pluginAbort || replacementQueued)) {
    const reason = params.pluginAbort?.reason ?? "active turn superseded by a new message";
    yield* journal.requestCancellation(
      params.conversationId,
      active.taskId,
      reason,
      params.pluginAbort?.commandId,
    );
    yield* cancelPendingElicits(journal, before, params.conversationId);
  }
  const accepted =
    params.pluginAbort || replacementQueued
      ? 0
      : yield* resolveElicitResponses(params, journal, before);
  if (accepted > 0 && params.onResumeAccepted) {
    yield* params.onResumeAccepted();
  }

  // SAFETY: registry storage erases manifest type witnesses; both tools are
  // restored from their exact pinned schemas before driver execution.
  const tools = createDurableToolRegistry([
    rootTool,
    foreignToolAdapter,
    ...[...(params.nativeTools?.bindings.values() ?? [])].map((binding) => binding.tool),
  ]);
  const executionModelSamplingService = yield* ExecutionModelSamplingServiceContext.get();
  const liveMessageIds = new Set<string>();
  const endedLiveMessageIds = new Set<string>();
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
    onLiveMessageStarted(messageId) {
      liveMessageIds.add(messageId);
    },
    onLiveMessageEnded(messageId) {
      endedLiveMessageIds.add(messageId);
    },
  });
  const effects = createDurableEffectRegistry(
    [
      createModelSamplingEffectRegistration(modelSamplingService),
      ...foreignEffects,
      ...(params.nativeTools?.effects ?? []),
    ],
    Object.values(manifest.effects),
  );
  const executionEffects = executionModelSamplingService
    ? createDurableEffectRegistry(
        [createModelSamplingEffectRegistration(executionModelSamplingService, "execution")],
        Object.values(manifest.effects),
      )
    : undefined;
  const effectOutcomeAcknowledger = executionModelSamplingService?.acknowledge
    ? function* (acknowledgement: DurableEffectOutcomeAcknowledgement): Operation<void> {
        if (
          acknowledgement.effect.name === MODEL_SAMPLE_EFFECT.name &&
          executionModelSamplingService.acknowledge
        ) {
          yield* executionModelSamplingService.acknowledge(
            {
              sessionId: acknowledgement.sessionId,
              taskId: acknowledgement.taskId,
              pullId: acknowledgement.pullId,
            },
            acknowledgement.outcomeDigest,
          );
        }
      }
    : undefined;
  const drivers = createProgramDriverRegistry([
    [
      "program",
      createLocalProgramDriver(tools, {
        foreignToolChild: foreignToolAdapterChild,
        ...(params.nativeTools?.setup ? { setup: params.nativeTools.setup } : {}),
        ...(executionEffects ? { executionEffects } : {}),
      }),
    ],
    ...(params.nativeTools?.drivers ?? []),
  ]);
  let cancellationFenceLost = false;
  let outcome: ProgramRunResult;
  try {
    outcome = yield* runLocalProgramActivation(
      {
        authority: journal.authority,
        drivers,
        effects,
        modelSamplingService,
        ...(effectOutcomeAcknowledger ? { effectOutcomeAcknowledger } : {}),
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
  } catch (error) {
    if (
      !(yield* isExpectedCancellationFenceLoss(
        journal.authority,
        params.conversationId,
        taskId,
        error,
      ))
    ) {
      throw error;
    }
    // A concurrent explicit stop owns journal terminalization. This activation
    // still owes its response consumer a valid terminal AG-UI outcome and must
    // help publish the idempotent authority capsule before returning.
    cancellationFenceLost = true;
    outcome = { state: "cancelled" };
  }
  const after = yield* journal.readJournal(params.conversationId, taskId);
  const events: StreamEvent[] = [];
  const projected = projectRecords(after.slice(before.length), after);
  events.push(
    ...projected.filter((event) => {
      if (
        event.type !== EventType.TEXT_MESSAGE_START &&
        event.type !== EventType.TEXT_MESSAGE_CONTENT &&
        event.type !== EventType.TEXT_MESSAGE_END
      ) {
        return true;
      }
      if (!liveMessageIds.has(event.messageId)) {
        return true;
      }
      return event.type === EventType.TEXT_MESSAGE_END && !endedLiveMessageIds.has(event.messageId);
    }),
  );
  if (outcome.state === "completed") {
    const terminalEvent: AGUIEvent = {
      type: EventType.RUN_FINISHED,
      ...params.agUiRun,
      outcome: { type: "success" },
    };
    const authority = yield* params.publishTerminal({
      outcome: outcome.value,
      disposition: "completed",
      events: [...projected, terminalEvent],
    });
    events.push({ type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority }, terminalEvent);
  } else if (outcome.state === "parked") {
    const pending = pendingElicit(after, outcome.pullId);
    if (pending) {
      const pendingCallId = pendingToolCallId(after, pending);
      if (pendingCallId) {
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pendingCallId });
      }
      const interrupt = projectInterrupt(after, pending, params);
      events.push(...publicActivityElicitSnapshots(after, pending, interrupt));
      events.push(interrupt);
    } else {
      events.push({
        type: EventType.RUN_ERROR,
        code: "PROGRAM_PARKED",
        message: "Program parked without a public input request",
      });
    }
    if (params.publishCheckpoint) {
      const authority = yield* params.publishCheckpoint({ events });
      const terminalIndex = Math.max(0, events.length - 1);
      events.splice(terminalIndex, 0, {
        type: CONVERSATION_AUTHORITY_FRAME_TYPE,
        authority,
      });
    }
  } else if (outcome.state === "cancelled") {
    if (cancellationFenceLost) {
      const terminalEvent: StreamEvent = {
        type: EventType.RUN_ERROR,
        code: "PROGRAM_CANCELLED",
        message: "Program was cancelled",
      };
      const authority = yield* params.publishTerminal({
        outcome: { code: "PROGRAM_CANCELLED", message: "Program was cancelled" },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push({ type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority }, terminalEvent);
    } else if (params.continueAfterCancellation || replacementQueued) {
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
      const terminalEvent: AGUIEvent = {
        type: EventType.RUN_ERROR,
        code: "PROGRAM_CANCELLED",
        message: params.pluginAbort?.reason ?? "Program was cancelled",
      };
      const authority = yield* params.publishTerminal({
        outcome: {
          code: "PROGRAM_CANCELLED",
          message: params.pluginAbort?.reason ?? "Program was cancelled",
        },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push({ type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority }, terminalEvent);
    }
  } else {
    const terminalEvent: AGUIEvent = {
      type: EventType.RUN_ERROR,
      code: outcome.error.code,
      message: outcome.error.message,
    };
    const authority = yield* params.publishTerminal({
      outcome: assertJson(outcome.error),
      disposition: "failed",
      events: [...projected, terminalEvent],
    });
    events.push({ type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority }, terminalEvent);
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

function nativeElicitResponseSchema(
  params: ProgramDriverChatEngineParams,
  records: DurableSemanticRecord[],
  pending: PendingElicit,
) {
  const opened = records.find(
    (record) => record.payload.type === "TaskOpened" && record.payload.taskId === pending.taskId,
  );
  const openedPayload = opened?.payload;
  if (!openedPayload || openedPayload.type !== "TaskOpened") {
    return undefined;
  }
  const binding = [...(params.nativeTools?.bindings.values() ?? [])].find(
    (candidate) => candidate.tool.manifest.digest === openedPayload.programDigest,
  );
  return binding?.tool.elicits[pending.descriptor.key]?.response;
}

/**
 * Native durable programs carry only portable descriptor evidence through the
 * journal. The installed authored contract remains the host command-lane
 * validation authority, so transformed response output is produced here
 * before the value is accepted by the durable program.
 */
function* normalizeNativeElicitCompletion(
  params: ProgramDriverChatEngineParams,
  records: DurableSemanticRecord[],
  pending: PendingElicit,
  completion: ElicitResponse["completion"],
): Operation<ElicitResponse["completion"]> {
  if (completion.action !== "accept") {
    return completion;
  }
  const schema = nativeElicitResponseSchema(params, records, pending);
  if (!schema) {
    return completion;
  }
  const parsed = validateAuthoredSchema(schema, completion.content);
  if (parsed.status !== "ok") {
    throw new CrankError(
      "elicit_response_invalid",
      `Elicitation response validation failed for key "${pending.descriptor.key}"`,
    );
  }
  try {
    return { action: "accept", content: assertJson(parsed.value) };
  } catch (error) {
    throw new CrankError(
      "elicit_response_invalid",
      `Elicitation response for key "${pending.descriptor.key}" is not JSON-serializable`,
      undefined,
      { cause: error },
    );
  }
}

function* resolveElicitResponses(
  params: ProgramDriverChatEngineParams,
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
): Operation<number> {
  let accepted = 0;
  for (const response of params.elicitResponses ?? []) {
    const pending = findPendingResponse(records, response);
    if (!pending) {
      continue;
    }
    const completion = yield* normalizeNativeElicitCompletion(
      params,
      records,
      pending,
      response.completion,
    );
    const result = yield* journal.resolvePending({
      sessionId: params.conversationId,
      taskId: pending.taskId,
      pullId: pending.pullId,
      audience: `user:${pending.descriptor.key}`,
      outcome: { status: "ok", value: assertJson(completion) },
    });
    if (result.status === "accepted" || result.status === "duplicate") {
      accepted += 1;
    }
  }
  return accepted;
}

function findPendingResponse(
  records: DurableSemanticRecord[],
  response: ElicitResponse,
): PendingElicit | undefined {
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
    const effectiveCallId = correlation.callId ?? payload.pullId;
    if (
      (response.callId === undefined || effectiveCallId === response.callId) &&
      (correlation.elicitId === response.elicitId || payload.pullId === response.elicitId)
    ) {
      return { ...payload, descriptor: payload.descriptor };
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

function publicActivitySnapshot(
  messageId: string,
  node: PublicActivityNode,
): ActivitySnapshotEvent {
  return {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId,
    activityType: "sweatpants:public-execution",
    replace: true,
    content: { version: 1, node: node as unknown as Json },
  };
}

function publicElicitActivityDelta(
  nodeId: string,
  state: "responded" | "cancelled",
): ActivityDeltaEvent {
  return {
    type: EventType.ACTIVITY_DELTA,
    messageId: nodeId,
    activityType: "sweatpants:public-execution",
    patch: [{ op: "replace", path: "/node/state", value: state }],
  };
}

function executionState(
  status: RecursiveExecutionNode["status"],
): PublicGenericActivityNode["state"] {
  return status === "complete"
    ? "complete"
    : status === "error"
      ? "error"
      : status === "cancelled"
        ? "cancelled"
        : "running";
}

function opaqueExecutionActivity(node: RecursiveExecutionNode): ActivitySnapshotEvent {
  return publicActivitySnapshot(node.placement.nodeId, {
    nodeId: node.placement.nodeId,
    parentNodeId: node.placement.parentNodeId,
    sequence: node.placement.sequence,
    kind: "activity",
    state: executionState(node.status),
    presentation: "opaque",
    publicData: { kind: "activity", activityType: "opaque-execution" },
  });
}

function publicActivityToolStartSnapshots(
  allRecords: DurableSemanticRecord[],
  record: DurableSemanticRecord,
  payload: Record<string, Json>,
): ActivitySnapshotEvent[] {
  const callId = String(payload["callId"]);
  const toolName = String(payload["tool"]);
  const parentNodeId = parentExecutionNodeId(allRecords, record);
  const messageId = `message:${record.payload.type === "DurableEmission" ? record.payload.taskId : "unknown"}:${callId}`;
  const executionId = `execution:${callId}`;
  return [
    publicActivitySnapshot(messageId, {
      nodeId: messageId,
      parentNodeId,
      sequence: record.payload.type === "DurableEmission" ? record.payload.emissionIndex : 0,
      kind: "message",
      state: "streaming",
      presentation: "public",
      publicData: { kind: "message", messageId, role: "assistant" },
    }),
    publicActivitySnapshot(executionId, {
      nodeId: executionId,
      parentNodeId: messageId,
      sequence: 0,
      kind: "tool-call",
      state: "input-available",
      presentation: "public",
      publicData: {
        kind: "tool-call",
        callId,
        name: toolName,
        input: payload["input"] ?? null,
        rawInput: JSON.stringify(payload["input"] ?? null),
      },
    }),
  ];
}

function publicActivityElicitSnapshots(
  records: DurableSemanticRecord[],
  pending: PendingElicit,
  interrupt: Extract<StreamEvent, { type: EventType.RUN_FINISHED }>,
): ActivitySnapshotEvent[] {
  if (interrupt.outcome?.type !== "interrupt") {
    return [];
  }
  const value = interrupt.outcome.interrupts[0];
  const metadata = value?.metadata ?? {};
  const facts = jsonRecord(metadata["sweatpants/elicitation"]);
  const bindingId = typeof facts?.["bindingId"] === "string" ? facts["bindingId"] : undefined;
  const responseContract = portableDescriptorFromJson(facts?.["responseContract"]);
  const contextContract = portableDescriptorFromJson(facts?.["contextContract"]);
  const placement = placementFromJson(facts?.["placement"]);
  if (!value || !bindingId || !responseContract || !placement) {
    return [];
  }
  const snapshots: ActivitySnapshotEvent[] = [];
  if (placement.parentNodeId === stableTupleHash(["execution-opaque", pending.taskId])) {
    const opaqueNodes = opaqueAncestryForTask(records, pending.taskId, placement.sequence);
    const first = opaqueNodes[0];
    if (!first) {
      throw new CrankError(
        "client_activity_parent_missing",
        "Unable to derive opaque execution ancestry",
      );
    }
    if (first.placement.parentNodeId === null) {
      const rootMessageId = `${first.placement.nodeId}:root`;
      snapshots.push(
        publicActivitySnapshot(rootMessageId, {
          nodeId: rootMessageId,
          parentNodeId: null,
          sequence: placement.sequence,
          kind: "message",
          state: "streaming",
          presentation: "public",
          publicData: { kind: "message", messageId: rootMessageId, role: "assistant" },
        }),
      );
      const rootToolId = `private-tool:${first.placement.nodeId}`;
      snapshots.push(
        publicActivitySnapshot(rootToolId, {
          nodeId: rootToolId,
          parentNodeId: rootMessageId,
          sequence: 0,
          kind: "tool-call",
          state: "input-available",
          presentation: "public",
          publicData: {
            kind: "tool-call",
            callId: first.placement.nodeId,
            name: "private-execution",
            input: null,
          },
        }),
      );
      snapshots.push(
        opaqueExecutionActivity({
          ...first,
          placement: { ...first.placement, parentNodeId: rootToolId, sequence: 0 },
        }),
      );
      for (const node of opaqueNodes.slice(1)) {
        snapshots.push(opaqueExecutionActivity(node));
      }
    } else {
      snapshots.push(...opaqueNodes.map(opaqueExecutionActivity));
    }
  }
  const key =
    typeof metadata["sweatpants/key"] === "string"
      ? metadata["sweatpants/key"]
      : pending.descriptor.key;
  const toolName =
    typeof metadata["sweatpants/toolName"] === "string" ? metadata["sweatpants/toolName"] : key;
  const callId =
    value.toolCallId ?? (typeof metadata["callId"] === "string" ? metadata["callId"] : value.id);
  const nodeId = placement.nodeId;
  snapshots.push(
    publicActivitySnapshot(nodeId, {
      nodeId,
      parentNodeId: placement.parentNodeId,
      sequence: placement.sequence,
      kind: "elicit",
      state: "pending",
      presentation: "public",
      publicData: {
        kind: "elicit",
        elicitId: value.id,
        bindingId,
        key,
        message: value.message ?? "Input required",
        ...(facts?.["context"] !== undefined ? { context: facts["context"] } : {}),
        responseContract,
        ...(contextContract !== undefined ? { contextContract } : {}),
        toolName,
        callId,
        producerSequence: placement.sequence,
      },
    }),
  );
  return snapshots;
}

function parentExecutionNodeId(
  records: DurableSemanticRecord[],
  record: DurableSemanticRecord,
): string | null {
  if (record.payload.type !== "DurableEmission") {
    return null;
  }
  return parentExecutionNodeIdForTask(records, record.payload.taskId);
}

function parentExecutionNodeIdForTask(
  records: DurableSemanticRecord[],
  taskId: string,
): string | null {
  const opened = records.find(
    (candidate) => candidate.payload.type === "TaskOpened" && candidate.payload.taskId === taskId,
  );
  const openedPayload = opened?.payload;
  if (!openedPayload || openedPayload.type !== "TaskOpened" || !openedPayload.parentPullId) {
    return null;
  }
  const parentPullIndex = records.findIndex(
    (candidate) =>
      candidate.payload.type === "PullRequested" &&
      candidate.payload.pullId === openedPayload.parentPullId,
  );
  for (let index = parentPullIndex - 1; index >= 0; index -= 1) {
    const candidate = records[index]?.payload;
    if (
      candidate?.type !== "DurableEmission" ||
      candidate.taskId !== openedPayload.parentTaskId ||
      candidate.descriptor.eventType !== "tool_started"
    ) {
      continue;
    }
    const payload = jsonRecord(candidate.descriptor.payload);
    if (typeof payload?.["callId"] === "string") {
      return `execution:${payload["callId"]}`;
    }
  }
  return null;
}

function opaqueAncestryForTask(
  records: DurableSemanticRecord[],
  taskId: string,
  leafSequence: number,
  leafTaskId = taskId,
): RecursiveExecutionNode[] {
  const opened = records.find(
    (candidate) => candidate.payload.type === "TaskOpened" && candidate.payload.taskId === taskId,
  );
  const openedPayload = opened?.payload;
  const publicParent = parentExecutionNodeIdForTask(records, taskId);
  const parentNodes =
    publicParent ||
    !openedPayload ||
    openedPayload.type !== "TaskOpened" ||
    !openedPayload.parentTaskId
      ? []
      : opaqueAncestryForTask(records, openedPayload.parentTaskId, 0, leafTaskId);
  const parentNodeId = publicParent ?? parentNodes.at(-1)?.placement.nodeId ?? null;
  const nodeId = stableTupleHash(["execution-opaque", taskId]);
  const node: RecursiveExecutionNode = {
    type: "execution",
    placement: {
      nodeId,
      parentNodeId,
      sequence: taskId === leafTaskId ? leafSequence : 0,
    },
    executionId: nodeId,
    presentation: "opaque",
    status: "running",
    children: [],
  };
  return [...parentNodes, node];
}

function modelSampleMessageId(
  records: readonly DurableSemanticRecord[],
  record: DurableSemanticRecord,
): string | null {
  if (record.payload.type !== "DurableEmission") return null;
  const recordIndex = records.indexOf(record);
  for (let index = recordIndex - 1; index >= 0; index -= 1) {
    const candidate = records[index]!.payload;
    if (
      candidate.type === "PullRequested" &&
      candidate.taskId === record.payload.taskId &&
      candidate.descriptor.kind === "effect" &&
      candidate.descriptor.name === modelSample.name
    ) {
      return `assistant:stream:${candidate.taskId}:${candidate.pullId}`;
    }
  }
  return null;
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
      if (request?.descriptor.kind === "elicit") {
        const completion =
          recordEntry.payload.outcome.status === "ok"
            ? jsonRecord(recordEntry.payload.outcome.value)
            : undefined;
        const cancelled =
          recordEntry.payload.outcome.status === "cancelled" || completion?.["action"] === "cancel";
        events.push(
          publicElicitActivityDelta(
            `elicit:${recordEntry.payload.pullId}`,
            cancelled ? "cancelled" : "responded",
          ),
        );
      }
      if (
        partial?.["interrupted"] === true &&
        typeof partial["text"] === "string" &&
        request?.descriptor.kind === "effect" &&
        request.descriptor.name === modelSample.name
      ) {
        const messageId = `assistant:stream:${recordEntry.payload.taskId}:${recordEntry.payload.pullId}`;
        events.push(
          { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId,
            delta: `${partial["text"]}\n\n[interrupted]`,
          },
          { type: EventType.TEXT_MESSAGE_END, messageId },
        );
      }
      const errorDetails =
        recordEntry.payload.outcome.status === "error"
          ? jsonRecord(recordEntry.payload.outcome.error.details)
          : undefined;
      const failedPartial = jsonRecord(errorDetails?.["publicAssistantPartial"]);
      const expectedMessageId = `assistant:stream:${recordEntry.payload.taskId}:${recordEntry.payload.pullId}`;
      if (
        request?.descriptor.kind === "effect" &&
        request.descriptor.name === modelSample.name &&
        failedPartial?.["messageId"] === expectedMessageId &&
        typeof failedPartial["text"] === "string" &&
        failedPartial["text"].length > 0
      ) {
        events.push(
          { type: EventType.TEXT_MESSAGE_START, messageId: expectedMessageId, role: "assistant" },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: expectedMessageId,
            delta: failedPartial["text"],
          },
          { type: EventType.TEXT_MESSAGE_END, messageId: expectedMessageId },
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
      const messageId =
        modelSampleMessageId(allRecords, recordEntry) ??
        `assistant:${recordEntry.payload.taskId}:${recordEntry.payload.emissionIndex}`;
      events.push(
        { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: payload["text"] },
        { type: EventType.TEXT_MESSAGE_END, messageId },
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
          type: EventType.TOOL_CALL_START,
          toolCallId: payload["callId"],
          toolCallName: payload["tool"],
          parentMessageId: `message:${recordEntry.payload.taskId}:${payload["callId"]}`,
        },
        {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: payload["callId"],
          delta: JSON.stringify(payload["input"] ?? null),
        },
        ...publicActivityToolStartSnapshots(allRecords, recordEntry, payload),
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
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: payload["callId"] });
      } else if (!startedPreviously) {
        events.push(
          {
            type: EventType.TOOL_CALL_START,
            toolCallId: payload["callId"],
            toolCallName: payload["tool"],
            parentMessageId: `message:${recordEntry.payload.taskId}:${payload["callId"]}`,
          },
          { type: EventType.TOOL_CALL_END, toolCallId: payload["callId"] },
        );
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${payload["callId"]}`,
        toolCallId: payload["callId"],
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
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pending.callId });
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${pending.callId}:cancelled`,
        toolCallId: pending.callId,
        content: JSON.stringify({ status: "cancelled", ...(partial ? { partial } : {}) }),
        role: "tool",
      });
    }
  }
  const errored = Array.from(records)
    .reverse()
    .find(
      (record) => record.payload.type === "TaskClosed" && record.payload.outcome.status === "error",
    );
  if (errored?.payload.type === "TaskClosed" && errored.payload.outcome.status === "error") {
    for (const pending of unfinishedToolCalls(allRecords)) {
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pending.callId });
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${pending.callId}:error`,
        toolCallId: pending.callId,
        content: JSON.stringify({ status: "error", error: errored.payload.outcome.error }),
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

function pendingToolCallId(records: DurableSemanticRecord[], pending: PendingElicit): string {
  return pendingCorrelation(records, pending).callId ?? pending.pullId;
}

function projectInterrupt(
  records: DurableSemanticRecord[],
  pending: NonNullable<ReturnType<typeof pendingElicit>>,
  params: ProgramDriverChatEngineParams,
): Extract<StreamEvent, { type: EventType.RUN_FINISHED }> {
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
        message: pending.descriptor.message,
        schema: objectSchema(responseProjection),
      }
    : { message: pending.descriptor.message, schema: objectSchema(responseProjection) };
  const responseContract =
    portableDescriptorFromJson(context?.["responseContract"]) ?? pending.descriptor.response;
  const contextContract =
    portableDescriptorFromJson(context?.["contextContract"]) ?? pending.descriptor.contextContract;
  const ownerInterfaceDigest =
    typeof context?.["ownerInterfaceDigest"] === "string"
      ? context["ownerInterfaceDigest"]
      : ownerInterfaceDigestForPending(records, pending, params);
  const bindingId = computeClientElicitBindingId({
    ownerInterfaceDigest,
    key:
      typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : pending.descriptor.key,
    response: responseContract,
    context: contextContract ?? null,
    clientMetadata: context?.["clientMetadata"] ?? null,
  });
  const placement = placementForPending(records, pending, correlation);
  const publicKey =
    typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : pending.descriptor.key;
  return {
    type: EventType.RUN_FINISHED,
    ...params.agUiRun,
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: pending.pullId,
          reason: "input_required",
          message: encoded.message,
          responseSchema: encoded.schema,
          toolCallId: correlation.callId ?? pending.pullId,
          metadata: {
            "sweatpants/key": publicKey,
            ...(correlation.toolName ? { "sweatpants/toolName": correlation.toolName } : {}),
            callId: correlation.callId ?? pending.pullId,
            ...(correlation.elicitId ? { elicitId: correlation.elicitId } : {}),
            "sweatpants/elicitation": {
              bindingId,
              ...(authoredContext !== undefined ? { context: authoredContext } : {}),
              responseContract,
              ...(contextContract ? { contextContract } : {}),
              placement,
            },
          },
        },
      ],
    },
  };
}

function ownerInterfaceDigestForPending(
  records: DurableSemanticRecord[],
  pending: PendingElicit,
  params: ProgramDriverChatEngineParams,
): string {
  const opened = records.find(
    (record) => record.payload.type === "TaskOpened" && record.payload.taskId === pending.taskId,
  );
  if (opened?.payload.type === "TaskOpened") {
    const programDigest = opened.payload.programDigest;
    const native = [...(params.nativeTools?.bindings.values() ?? [])].find(
      (binding) => binding.tool.manifest.digest === programDigest,
    );
    const interfaceDigest = (native?.tool as { interfaceDigest?: string } | undefined)
      ?.interfaceDigest;
    if (interfaceDigest) {
      return interfaceDigest;
    }
  }
  const context = jsonRecord(pending.descriptor.context);
  const foreignToolName =
    typeof context?.["foreignTool"] === "string"
      ? context["foreignTool"]
      : typeof context?.["toolName"] === "string"
        ? context["toolName"]
        : undefined;
  const inventoryEntry = foreignToolName
    ? params.toolInventoryEntries?.find((entry) => entry.definition.name === foreignToolName)
    : undefined;
  if (inventoryEntry?.interfaceDigest) {
    return inventoryEntry.interfaceDigest;
  }
  const toolName =
    foreignToolName ??
    (opened?.payload.type === "TaskOpened" ? opened.payload.programId : pending.descriptor.key);
  return sha256(
    `sweatpants.tool-interface\\n${canonicalJson({
      name: toolName,
      response: pending.descriptor.response,
      context: pending.descriptor.contextContract ?? null,
    })}`,
  );
}

function placementForPending(
  records: DurableSemanticRecord[],
  pending: PendingElicit,
  correlation: { callId?: string },
): { nodeId: string; parentNodeId: string | null; sequence: number } {
  const callId = correlation.callId;
  const publicExecution = callId
    ? records.some(
        (record) =>
          record.payload.type === "DurableEmission" &&
          record.payload.descriptor.eventType === "tool_started" &&
          jsonRecord(record.payload.descriptor.payload)?.["callId"] === callId,
      )
    : false;
  const parentNodeId =
    callId && publicExecution
      ? `execution:${callId}`
      : stableTupleHash(["execution-opaque", pending.taskId]);
  const sequence = pending.pullIndex;
  return {
    nodeId: `elicit:${pending.pullId}`,
    parentNodeId,
    sequence: Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0,
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

function* isExpectedCancellationFenceLoss(
  authority: DurableJournalAuthorityService,
  sessionId: string,
  taskId: string,
  error: unknown,
): Operation<boolean> {
  if (
    !(error instanceof CrankError) ||
    !["stale_program_capability", "stale_activation", "unknown_target", "task_terminal"].includes(
      error.code,
    )
  ) {
    return false;
  }
  try {
    return (yield* authority.cancellationState(sessionId, taskId)).type !== "none";
  } catch {
    return false;
  }
}

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
  const ownerId = stableTupleHash([
    "host-activation",
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
  const sortedTools = [...params.toolSchemas].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const tool of sortedTools) {
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

function placementFromJson(value: Json | undefined): TreePlacement | undefined {
  const input = jsonRecord(value);
  if (!input) {
    return undefined;
  }
  const nodeId = input["nodeId"];
  const parentNodeId = input["parentNodeId"];
  const sequence = input["sequence"];
  return typeof nodeId === "string" &&
    (parentNodeId === null || typeof parentNodeId === "string") &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? { nodeId, parentNodeId, sequence }
    : undefined;
}

function portableDescriptorFromJson(value: Json | undefined) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    return undefined;
  }
}
