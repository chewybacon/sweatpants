import { EventType, type AGUIEvent } from "@ag-ui/core";
import {
  ProgramPlacementContext,
  type DurableEffectRegistration,
} from "@sweatpants/durable-effects";
import {
  createDurableEffectRegistry,
  DurableEffectRegistryContext,
  DurableEffects,
  DurableEffectRouting,
  effectContractDigest,
} from "@sweatpants/durable-effects/runtime";
import {
  createPullResolverRegistry,
  createWaitPullResolver,
  driveActivation,
  driveProgramDriverActivation,
  driveWorkflowTree,
  durableToolWorkflow,
  hostAuthority,
  modelPullOwnerFence,
  settleParkedPull,
  type DurableSemanticRecord,
  type JournalAuthorityContract,
} from "@sweatpants/journal-authority";
import {
  assistantText,
  assistantToolCalls,
  decodeModelContextSource,
  decodeModelSampleResult,
  encodeModelSampleSourceRequest,
  type ModelSampleSourceRequest,
  ExecutionModelSamplingServiceContext,
  MODEL_SAMPLE_CONTRACT,
  ModelContextSourceResolverContext,
  type ModelContextSource,
} from "@sweatpants/model-sampling";
import { createParkedSamplePullResolver } from "./parked-sample-resolver.ts";

import { resource, type Operation, type Stream } from "effection";
import {
  CrankError,
  PullApplicationError,
  assertReplayedCanonicalValue,
  createPinnedDurableProgram,
  createDurableToolRegistry,
  createProgramDriverRegistry,
  ProgramDriverRegistryContext,
  stableProgramAttachmentId,
  type AttachProgramRequest,
  type DurableProgramContext,
  type ProgramRunResult,
  type PinnedProgram,
  type ProgramRoute,
  exactProgramKey,
} from "@sweatpants/durable-execution";
import {
  note,
  runProjectionProgram,
  stage,
  type ProjectionProgram,
} from "@sweatpants/foundation/projection";
import {
  combine,
  fold,
  mapFold,
  runFold,
  type Fold,
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  stableTupleHash,
  type Json,
  type JsonObject,
} from "@sweatpants/foundation";
import {
  FOREIGN_TOOL_ADAPTER_PROGRAM,
  foreignToolAdapter,
  foreignToolInvocationId,
} from "@sweatpants/tool-session/foreign";
import { ToolInvocationHostPort } from "@sweatpants/tool-session";
import { parsePortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { parseInteractionBinding } from "@sweatpants/agent-sdk";
import {
  CONVERSATION_AUTHORITY_FRAME_TYPE,
  type ActivityDeltaEvent,
  type ActivitySnapshotEvent,
  type ConversationStreamEvent,
  type PublicActivityNode,
  type PublicGenericActivityNode,
} from "@sweatpants/chat-core";

import { runWithRenewedActivationLease } from "../host/activation-lease-coordinator.ts";

type StreamEvent = ConversationStreamEvent;
import {
  nativeProgramIdentities,
  requiresFencedActivation,
  type ProgramDriverNativeToolComposition,
} from "../program-driver/native-tools.ts";
import type { ProgramDriverJournal, ProgramDriverJournalStore } from "./program-driver-journal.ts";
import { runWorkflowProgramActivation } from "./program-workflow-host.ts";
import { createToolRuntimeForeignEffectRegistrations } from "./program-driver-tool-runtime.ts";
import type { ElicitResponse, WorkflowChatEngineParams } from "./types.ts";
import {
  createHostModelSamplingService,
  stageProgramDriverModelSampleInput,
  preparedModelContextByteLimit,
  resolveModelContextSource,
  stageModelContextSource,
} from "./model-sampling/service.ts";
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

type ProgramDriverChatEngineParams = WorkflowChatEngineParams & {
  journalStore: ProgramDriverJournalStore;
  foreignEffects?: readonly [DurableEffectRegistration, DurableEffectRegistration];
  nativeTools?: ProgramDriverNativeToolComposition;
  continueAfterCancellation?: boolean;
  /** Host-owned delivery projection invoked only inside the active crank turn. */
  liveEvent?: (event: StreamEvent) => Operation<void>;
};

import {
  manifest,
  type ChatProgramInput,
  type ChatToolCatalog,
  type ChatToolCatalogEntry,
} from "./program-driver-schema.ts";

// Root tool owns the deterministic sample/tool loop and its durable continuation semantics.
// fallow-ignore-next-line complexity
const rootTool = createPinnedDurableProgram(manifest, function* (input, context) {
  const contextSource = decodeModelContextSource(input.contextSource);
  const completedCallIds = new Set<string>();
  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    const sampleRequest: ModelSampleSourceRequest = {
      invocation: {
        context: contextSource,
        ...(iteration === 0 && input.toolChoice !== undefined
          ? { options: { toolChoice: input.toolChoice } }
          : {}),
      },
      tools: {
        type: "embedded",
        tools: Object.values(input.catalog.entries).map((entry) => entry.model),
      },
      response: { type: "message" },
    };
    const sampled = decodeModelSampleResult(
      yield* context.pull(
        assertJson({
          kind: "sample",
          input: encodeModelSampleSourceRequest(sampleRequest),
        }),
      ),
    );
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
  "foreign_continuation_lost",
  "foreign_tool_start_failed",
  "foreign_tool_error",
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
    const child =
      entry.kind === "program"
        ? { ...entry.program, input: call.input }
        : {
            ...FOREIGN_TOOL_ADAPTER_PROGRAM,
            input: {
              driver: entry.driver,
              tool: entry.tool,
              input: call.input,
              durability: entry.durability,
              route: call.id,
            },
          };
    const result = yield* context.pull(assertJson({ kind: "invoke", child }));
    return { result, failed: false };
  } catch (error) {
    if (!(error instanceof PullApplicationError)) {
      throw error;
    }
    const { code, message, details } = error.applicationError;
    if (
      !RECOVERABLE_FOREIGN_FAILURES.has(code) ||
      (code === "foreign_tool_error" &&
        (entry.kind !== "foreign-tool" || entry.driver !== "tool-session"))
    ) {
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

/** Runs one HTTP chat activation through the authority-backed workflow tree. */
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
  let recoveredExecutionEpoch = 1;
  if (recovery.status === "active") {
    for (const task of recovery.activeTasks) {
      const replaced = yield* journal.replaceAttachment(
        params.conversationId,
        task.taskId,
        task.attachmentId,
      );
      if (task.taskId === recovery.taskId) recoveredExecutionEpoch = replaced.executionEpoch;
    }
  }
  const turnNumber = yield* journal.rootTaskCount(params.conversationId);
  const taskId = active?.taskId ?? `turn-${turnNumber}/root`;
  const turnId = active?.turnId ?? `turn-${turnNumber}`;
  let before = yield* journal.readJournal(params.conversationId, taskId);
  const foreignDriver = scopedForeignEffects ? "tool-session" : "chat-tool-runtime";
  if (!params.modelContextSource) {
    throw new CrankError(
      "model_context_source_invalid",
      "Chat-root execution requires an authoritative conversation context source",
    );
  }
  const modelContextSource = {
    ...params.modelContextSource,
    taskId,
  };
  const requestedInput: ChatProgramInput = {
    contextSource: modelContextSource,
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
    executionEpoch: recoveredExecutionEpoch,
    affinity: { kind: "conversation" as const, key: params.conversationId },
  };
  let openedCapability = "";
  if (!active) {
    try {
      const openedTask = yield* journal.openTask({
        sessionId: params.conversationId,
        turnId,
        taskId,
        manifest,
        input,
        executionEpoch: 1,
        attachmentId: stableProgramAttachmentId(attach),
        audience: "workflow-host",
        elicitAudience: params.participantId,
      });
      openedCapability = openedTask.programCapability;
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
    yield* cancelPendingElicits(journal, before, params.conversationId, params.participantId);
    yield* disposeForeignChildSessions(before, params.conversationId);
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
  const samplingServiceOptions = {
    model: params.model,
    ...(params.streamOptions ? { streamOptions: params.streamOptions } : {}),
    catalog: input.catalog,
    ...(params.historyPolicy ? { historyPolicy: params.historyPolicy } : {}),
    onLiveMessageStarted(messageId: string) {
      liveMessageIds.add(messageId);
    },
    onLiveMessageEnded(messageId: string) {
      endedLiveMessageIds.add(messageId);
    },
  };
  const hostModelSamplingService = createHostModelSamplingService({
    ...samplingServiceOptions,
    journal,
    conversationStore: params.conversationStore,
    conversationId: params.conversationId,
  });
  const routeResolverFn = function* (
    program: PinnedProgram,
    parentRoute: ProgramRoute,
  ): Operation<ProgramRoute> {
    const binding = [...(params.nativeTools?.bindings.values() ?? [])].find(
      (candidate) =>
        candidate.tool.manifest.programId === program.id &&
        candidate.tool.manifest.version === program.version &&
        candidate.tool.manifest.digest === program.digest,
    );
    return binding?.route ?? parentRoute;
  };
  const hostEffectRegistrations = [...foreignEffects, ...(params.nativeTools?.effects ?? [])];
  const workflowEffectRegistrations = hostEffectRegistrations;
  // ProgramDriver remains the intentional transport protocol for remote and
  // process-independent evaluators. This registry is used only when a child
  // route selects such a driver; local programs stay on the workflow runtime.
  const remoteEffects = createDurableEffectRegistry(
    hostEffectRegistrations,
    Object.values(manifest.effects),
  );
  const remoteDrivers = createProgramDriverRegistry(params.nativeTools?.drivers ?? []);
  // Shared context-source resolver for sampling on both activation paths.
  const modelContextSourceResolver = function* (source: ModelContextSource) {
    return yield* resolveModelContextSource(source, {
      conversationStore: params.conversationStore,
      journal,
      maxCanonicalBytes: preparedModelContextByteLimit(params.model.contextWindow),
    });
  };

  // Host-owned parked interaction transports. Child composition remains
  // topology and is handled by driveWorkflowTree rather than this registry.
  const parkedPullResolvers = createPullResolverRegistry([
    createParkedSamplePullResolver({
      service: function* (context) {
        if (!context.placement) {
          throw new CrankError(
            "sample_pull_unresolved",
            "Model sampling route requires attachment placement",
          );
        }
        const routed = yield* DurableEffectRouting.operations.route({
          definition: MODEL_SAMPLE_CONTRACT,
          effectContractDigest: effectContractDigest(MODEL_SAMPLE_CONTRACT),
          sessionId: context.sessionId,
          taskId: context.taskId,
          pullId: context.pullId,
          attemptId: modelPullOwnerFence(context.pullId, context.placement.executionEpoch),
          program: context.placement.program,
          programRoute: context.placement.route,
        });
        if (routed.placement === "host") {
          return { service: hostModelSamplingService, executor: "host" };
        }
        if (routed.placement === "execution" && executionModelSamplingService) {
          return { service: executionModelSamplingService, executor: "execution" };
        }
        throw new CrankError(
          "effect_placement_unavailable",
          "Selected model-sampling service is unavailable",
        );
      },
      *journalIdentity() {
        return yield* journal.withAuthority((authority) =>
          authority.query({ type: "authority.identity" }),
        );
      },
      sourceResolver: modelContextSourceResolver,
    }),
    createWaitPullResolver(),
  ]);

  const activateWorkflowTask = function* (request: {
    readonly attach: AttachProgramRequest;
    readonly initialProgramCapability?: string;
  }): Operation<ProgramRunResult> {
    const currentAttach = request.attach;
    const tool = tools.get(exactProgramKey(currentAttach.program));
    if (!tool) {
      throw new CrankError("program_version_unavailable", "No pinned program for activation");
    }
    return yield* runWorkflowProgramActivation(
      {
        installAuthority: () => journal.install(),
        attach: currentAttach,
        driverKind: "workflow",
        effectRegistrations: workflowEffectRegistrations,
        routeResolver: routeResolverFn,
        modelContextSourceResolver,
        modelContextSourceStager: (context) =>
          stageModelContextSource(context, params.conversationId),
        ...(params.nativeTools?.setup ? { setup: params.nativeTools.setup } : {}),
      },
      function* (authority) {
        let programCapability = request.initialProgramCapability;
        if (programCapability === undefined) {
          const bound = yield* authority.command({
            type: "execution.bind-attachment",
            request: {
              sessionId: currentAttach.sessionId,
              taskId: currentAttach.taskId,
              attachmentId: `${stableProgramAttachmentId(currentAttach)}-${currentAttach.executionEpoch}`,
              executionEpoch: currentAttach.executionEpoch,
            },
          });
          programCapability = bound.programCapability;
        }
        return yield* driveActivation({
          attach: currentAttach,
          authority: hostAuthority(authority),
          programCapability,
          workflow: durableToolWorkflow(tool, currentAttach.input),
        });
      },
    );
  };

  const activateRemoteTask = function* (
    authority: JournalAuthorityContract,
    request: {
      readonly attach: AttachProgramRequest;
      readonly initialProgramCapability?: string;
    },
    activationOwnerId?: string,
  ): Operation<ProgramRunResult> {
    const kind = routeDriverKind(request.attach.route);
    const driver = remoteDrivers.get(kind);
    if (!driver) {
      throw new CrankError("unknown_target", `No program driver for ${kind}`);
    }
    return yield* ProgramDriverRegistryContext.with(remoteDrivers, function* () {
      return yield* ModelContextSourceResolverContext.with(
        modelContextSourceResolver,
        function* () {
          return yield* DurableEffectRegistryContext.with(remoteEffects, function* () {
            return yield* driveProgramDriverActivation({
              authority,
              driver,
              attach: request.attach,
              ...(request.initialProgramCapability === undefined
                ? {}
                : { initialProgramCapability: request.initialProgramCapability }),
              ...(activationOwnerId === undefined ? {} : { activationOwnerId }),
              *stageSampleInput(input) {
                return yield* stageProgramDriverModelSampleInput(input, params.conversationId);
              },
              effects: {
                *route({ authorization, definition }) {
                  const routed = yield* DurableEffectRouting.operations.route({
                    definition,
                    effectContractDigest: authorization.effectContractDigest,
                    sessionId: authorization.sessionId,
                    taskId: authorization.taskId,
                    pullId: authorization.pullId,
                    attemptId: authorization.attemptId,
                    program: request.attach.program,
                    programRoute: request.attach.route,
                  });
                  if (routed.placement !== "host" && routed.placement !== "execution") {
                    throw new CrankError("effect_placement_unavailable", "Effect route is invalid");
                  }
                  return routed.placement;
                },
                *executeHost(authorization, placement) {
                  return yield* ProgramPlacementContext.with(placement, function* () {
                    return yield* DurableEffects.operations.execute(authorization);
                  });
                },
              },
            });
          });
        },
      );
    });
  };

  const driveTreeAtEpoch = function* (
    executionEpoch: number,
    initialProgramCapability?: string,
    activationOwnerId?: string,
  ): Operation<ProgramRunResult> {
    const rootAttach = { ...attach, executionEpoch };
    return yield* journal.withAuthority(function* (authority) {
      return yield* driveWorkflowTree({
        authority,
        attach: rootAttach,
        ...(initialProgramCapability === undefined ? {} : { initialProgramCapability }),
        host: {
          activate(request) {
            return routeDriverKind(request.attach.route) === "program"
              ? activateWorkflowTask(request)
              : activateRemoteTask(authority, request, activationOwnerId);
          },
          *manifest(program) {
            const tool = tools.get(exactProgramKey(program));
            if (!tool) {
              throw new CrankError(
                "program_version_unavailable",
                `No pinned program ${exactProgramKey(program)}`,
              );
            }
            return tool.manifest;
          },
          route: routeResolverFn,
          *settle(parked, currentAttach) {
            const resolver = parkedPullResolvers.get(parked.reason);
            if (!resolver) {
              return false;
            }
            yield* settleParkedPull({
              authority,
              resolver,
              attach: currentAttach,
              pullId: parked.pullId,
              driverKind: routeDriverKind(currentAttach.route),
            });
            return true;
          },
        },
      });
    });
  };
  let cancellationFenceLost = false;
  let outcome: ProgramRunResult;
  if (!requiresFencedActivation(params.nativeTools)) {
    outcome = yield* driveTreeAtEpoch(attach.executionEpoch, active ? undefined : openedCapability);
  } else {
    // Fenced native bindings: the SAME workflow turns, wrapped in the
    // host-side activation lease (claim/renew/release). The kernel's
    // epoch-gated bind + session lease state provide zombie protection.
    try {
      outcome = yield* journal.withAuthority(function* (rootAuthority) {
        return yield* runFencedActivation(
          rootAuthority,
          params.conversationId,
          attach.executionEpoch,
          true,
          function* (claimedEpoch, activationOwnerId) {
            return yield* driveTreeAtEpoch(claimedEpoch, undefined, activationOwnerId);
          },
        );
      });
    } catch (error) {
      if (
        !(yield* journal.withAuthority((authority) =>
          isExpectedCancellationFenceLoss(authority, params.conversationId, taskId, error),
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
    const published = yield* params.publishTerminal({
      outcome: outcome.value,
      disposition: "completed",
      events: [...projected, terminalEvent],
    });
    events.push(
      ...(published.window ? [published.window] : []),
      { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
      terminalEvent,
    );
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
      const published = yield* params.publishCheckpoint({ events });
      const terminalIndex = Math.max(0, events.length - 1);
      events.splice(terminalIndex, 0, ...(published.window ? [published.window] : []), {
        type: CONVERSATION_AUTHORITY_FRAME_TYPE,
        authority: published.authority,
      });
    }
  } else if (outcome.state === "cancelled") {
    if (cancellationFenceLost) {
      const terminalEvent: StreamEvent = {
        type: EventType.RUN_ERROR,
        code: "PROGRAM_CANCELLED",
        message: "Program was cancelled",
      };
      const published = yield* params.publishTerminal({
        outcome: { code: "PROGRAM_CANCELLED", message: "Program was cancelled" },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push(
        ...(published.window ? [published.window] : []),
        { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
        terminalEvent,
      );
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
      const published = yield* params.publishTerminal({
        outcome: {
          code: "PROGRAM_CANCELLED",
          message: params.pluginAbort?.reason ?? "Program was cancelled",
        },
        disposition: "cancelled",
        events: [...projected, terminalEvent],
      });
      events.push(
        ...(published.window ? [published.window] : []),
        { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
        terminalEvent,
      );
    }
  } else {
    const terminalEvent: AGUIEvent = {
      type: EventType.RUN_ERROR,
      code: outcome.error.code,
      message: outcome.error.message,
    };
    const published = yield* params.publishTerminal({
      outcome: assertJson(outcome.error),
      disposition: "failed",
      events: [...projected, terminalEvent],
    });
    events.push(
      ...(published.window ? [published.window] : []),
      { type: CONVERSATION_AUTHORITY_FRAME_TYPE, authority: published.authority },
      terminalEvent,
    );
  }

  return events;
}

function* disposeForeignChildSessions(
  records: readonly DurableSemanticRecord[],
  sessionId: string,
): Operation<void> {
  const closed = new Set(
    records.flatMap((record) =>
      record.payload.type === "TaskClosed" ? [record.payload.taskId] : [],
    ),
  );
  const taskIds = records.flatMap((record) =>
    record.payload.type === "TaskOpened" &&
    record.payload.programId === FOREIGN_TOOL_ADAPTER_PROGRAM.id &&
    !closed.has(record.payload.taskId)
      ? [record.payload.taskId]
      : [],
  );
  if (taskIds.length === 0) {
    return;
  }
  const host = yield* ToolInvocationHostPort.use();
  for (const taskId of taskIds) {
    yield* host.dispose(foreignToolInvocationId(sessionId, taskId));
  }
}

function* cancelPendingElicits(
  journal: ProgramDriverJournal,
  records: DurableSemanticRecord[],
  sessionId: string,
  participantId: string,
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
      audience: participantId,
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
      audience: params.participantId,
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
    content: { version: 1, node: assertJson(node) },
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

type PullRequestedRecord = Extract<DurableSemanticRecord["payload"], { type: "PullRequested" }>;

/** Injective, allocation-cheap composite key. Ids are opaque, so length-prefix. */
function pullKey(taskId: string, pullId: string): string {
  return `${taskId.length}:${taskId}:${pullId}`;
}

type RecordProjectionNote =
  | {
      readonly kind: "records-indexed";
      readonly records: number;
      readonly pullRequests: number;
      readonly unfinishedTools: number;
    }
  | { readonly kind: "events-projected"; readonly events: number };

interface RecordProjectionIndex {
  readonly pullRequests: ReadonlyMap<string, PullRequestedRecord>;
  readonly previousToolStarts: ReadonlyMap<string, Record<string, Json>>;
  readonly unfinishedToolCalls: readonly { callId: string; tool: string }[];
  readonly cancellationPartials: ReadonlyMap<string, Json>;
  /** Public assistant message identity for each durable emission. */
  readonly modelMessageIds: ReadonlyMap<DurableSemanticRecord, string | null>;
  readonly cancellationClosed: boolean;
  readonly errorClosed: DurableSemanticRecord | undefined;
}

function indexRecordProjection(
  records: readonly DurableSemanticRecord[],
  allRecords: readonly DurableSemanticRecord[],
): RecordProjectionIndex {
  const scanned = runFold(allRecordsIndexFold, allRecords);
  const terminal = runFold(terminalOutcomeFold, records);
  return { ...scanned, ...terminal };
}

/** Pulls by id; first occurrence wins. */
const pullRequestsFold: Fold<
  DurableSemanticRecord,
  ReadonlyMap<string, PullRequestedRecord>
> = fold(() => {
  const pulls = new Map<string, PullRequestedRecord>();
  return {
    step(record) {
      if (record.payload.type === "PullRequested" && !pulls.has(record.payload.pullId)) {
        pulls.set(record.payload.pullId, record.payload);
      }
    },
    done: () => pulls,
  };
});

/** Started/completed pairing resolves in `done()`, not in a second pass. */
const toolLifecycleFold: Fold<
  DurableSemanticRecord,
  {
    readonly previousToolStarts: ReadonlyMap<string, Record<string, Json>>;
    readonly unfinishedToolCalls: readonly { callId: string; tool: string }[];
  }
> = fold(() => {
  const started = new Map<string, string>();
  const completed = new Set<string>();
  const previousToolStarts = new Map<string, Record<string, Json>>();
  return {
    step(record) {
      if (record.payload.type !== "DurableEmission") return;
      const payload = jsonRecord(record.payload.descriptor.payload);
      if (!payload || typeof payload["callId"] !== "string") return;
      if (
        record.payload.descriptor.eventType === "tool_started" &&
        typeof payload["tool"] === "string"
      ) {
        started.set(payload["callId"], payload["tool"]);
        previousToolStarts.set(payload["callId"], payload);
      }
      if (record.payload.descriptor.eventType === "tool_completed") {
        completed.add(payload["callId"]);
      }
    },
    done: () => ({
      previousToolStarts,
      unfinishedToolCalls: [...started]
        .filter(([callId]) => !completed.has(callId))
        .map(([callId, tool]) => ({ callId, tool })),
    }),
  };
});

/** Cancelled partials, keyed by pull id; joined against pulls in `done()`. */
const cancellationLinksFold: Fold<
  DurableSemanticRecord,
  readonly { readonly pullId: string; readonly partial: Json }[]
> = fold(() => {
  const links: { readonly pullId: string; readonly partial: Json }[] = [];
  return {
    step(record) {
      const payload = record.payload;
      if (payload.type !== "PullResolved" || payload.outcome.status !== "cancelled") return;
      if (payload.outcome.partial === undefined) return;
      links.push({ pullId: payload.pullId, partial: payload.outcome.partial });
    },
    done: () => links,
  };
});

const preparedFold: Fold<DurableSemanticRecord, ReadonlyMap<string, string>> = fold(() => {
  const prepared = new Map<string, string>();
  return {
    step(record) {
      if (record.payload.type === "ModelContextPrepared") {
        prepared.set(
          pullKey(record.payload.taskId, record.payload.pullId),
          record.payload.fact.publicMessageId,
        );
      }
    },
    done: () => prepared,
  };
});

/**
 * Links each emission to the most recent preceding model pull for its task.
 * A preparation may be journaled after its emission, so the link is captured
 * positionally here and resolved against `prepared` in `done()`.
 */
const modelLinksFold: Fold<
  DurableSemanticRecord,
  ReadonlyMap<DurableSemanticRecord, PullRequestedRecord | null>
> = fold(() => {
  const lastModelPullByTask = new Map<string, PullRequestedRecord>();
  const links = new Map<DurableSemanticRecord, PullRequestedRecord | null>();
  return {
    step(record) {
      const payload = record.payload;
      if (payload.type === "PullRequested" && payload.descriptor.kind === "sample") {
        lastModelPullByTask.set(payload.taskId, payload);
        return;
      }
      if (payload.type !== "DurableEmission") return;
      links.set(record, lastModelPullByTask.get(payload.taskId) ?? null);
    },
    done: () => links,
  };
});

/** Every index over the full journal, in one traversal. */
const allRecordsIndexFold = mapFold(
  combine({
    pullRequests: pullRequestsFold,
    toolLifecycle: toolLifecycleFold,
    cancellationLinks: cancellationLinksFold,
    prepared: preparedFold,
    modelLinks: modelLinksFold,
  }),
  ({ pullRequests, toolLifecycle, cancellationLinks, prepared, modelLinks }) => ({
    pullRequests,
    previousToolStarts: toolLifecycle.previousToolStarts,
    unfinishedToolCalls: toolLifecycle.unfinishedToolCalls,
    cancellationPartials: new Map(
      cancellationLinks.flatMap(({ pullId, partial }) => {
        const request = pullRequests.get(pullId);
        return request?.descriptor.kind === "effect" &&
          request.descriptor.resolver.route !== undefined
          ? ([[request.descriptor.resolver.route, partial]] as const)
          : [];
      }),
    ) as ReadonlyMap<string, Json>,
    modelMessageIds: new Map(
      [...modelLinks].map(([record, pull]) => [
        record,
        pull
          ? (prepared.get(pullKey(pull.taskId, pull.pullId)) ?? pull.publicMessageId ?? null)
          : null,
      ]),
    ) as ReadonlyMap<DurableSemanticRecord, string | null>,
  }),
);

/** Terminal outcome is scoped to the new records, not the whole journal. */
const terminalOutcomeFold: Fold<
  DurableSemanticRecord,
  {
    readonly cancellationClosed: boolean;
    readonly errorClosed: DurableSemanticRecord | undefined;
  }
> = fold(() => {
  let cancellationClosed = false;
  let errorClosed: DurableSemanticRecord | undefined;
  return {
    step(record) {
      if (record.payload.type !== "TaskClosed") return;
      if (record.payload.outcome.status === "cancelled") cancellationClosed = true;
      if (record.payload.outcome.status === "error") errorClosed = record;
    },
    done: () => ({ cancellationClosed, errorClosed }),
  };
});

function* projectRecordsProgram(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
): ProjectionProgram<StreamEvent[], RecordProjectionNote> {
  const index = yield* stage("index-records", function* () {
    const indexed = indexRecordProjection(records, allRecords);
    yield* note({
      kind: "records-indexed",
      records: records.length,
      pullRequests: indexed.pullRequests.size,
      unfinishedTools: indexed.unfinishedToolCalls.length,
    });
    return indexed;
  });

  return yield* stage("project-events", function* () {
    const events = projectRecordsFromIndex(records, allRecords, index);
    yield* note({ kind: "events-projected", events: events.length });
    return events;
  });
}

function projectRecords(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
): StreamEvent[] {
  const outcome = runProjectionProgram(
    () => projectRecordsProgram(records, allRecords),
    (error) => error,
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function projectRecordsFromIndex(
  records: DurableSemanticRecord[],
  allRecords: DurableSemanticRecord[],
  index: RecordProjectionIndex,
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const activeToolCalls = new Set<string>();
  for (const recordEntry of records) {
    if (recordEntry.payload.type === "AssistantPartialAccepted") {
      const fact = recordEntry.payload.fact;
      events.push(
        { type: EventType.TEXT_MESSAGE_START, messageId: fact.messageId, role: "assistant" },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: fact.messageId,
          delta: fact.disposition === "interrupted" ? `${fact.text}\n\n[interrupted]` : fact.text,
        },
        { type: EventType.TEXT_MESSAGE_END, messageId: fact.messageId },
      );
      continue;
    }
    if (recordEntry.payload.type === "PullResolved") {
      const request = index.pullRequests.get(recordEntry.payload.pullId);
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
      const messageId = index.modelMessageIds.get(recordEntry) ?? null;
      if (!messageId) continue;
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
      const startedPreviously = index.previousToolStarts.get(payload["callId"]);
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
      const failed = payload["failed"] === true;
      const result = payload["result"] ?? null;
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${payload["callId"]}`,
        toolCallId: payload["callId"],
        content: JSON.stringify(
          failed
            ? {
                status: "error",
                errorText:
                  typeof (jsonRecord(result)?.["error"] as Record<string, Json> | undefined)?.[
                    "message"
                  ] === "string"
                    ? (jsonRecord(result)?.["error"] as Record<string, Json>)["message"]
                    : "Tool execution failed",
                detail: result,
              }
            : { status: "ok", output: result },
        ),
        role: "tool",
      });
    }
  }

  if (index.cancellationClosed) {
    for (const pending of index.unfinishedToolCalls) {
      const partial = index.cancellationPartials.get(pending.callId);
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pending.callId });
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${pending.callId}:cancelled`,
        toolCallId: pending.callId,
        content: JSON.stringify({
          status: "cancelled",
          ...(partial ? { partial } : {}),
        }),
        role: "tool",
      });
    }
  }
  const errored = index.errorClosed;
  if (errored?.payload.type === "TaskClosed" && errored.payload.outcome.status === "error") {
    for (const pending of index.unfinishedToolCalls) {
      if (activeToolCalls.delete(pending.callId)) {
        events.push({ type: EventType.TOOL_CALL_END, toolCallId: pending.callId });
      }
      events.push({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `tool:${pending.callId}:error`,
        toolCallId: pending.callId,
        content: JSON.stringify({
          status: "interrupted",
          outcome: "unknown",
          error: errored.payload.outcome.error,
        }),
        role: "tool",
      });
    }
  }
  return events;
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
  const encoded = {
    message: pending.descriptor.message,
    schema: objectSchema(responseProjection),
  };
  const publicKey =
    typeof context?.["foreignKey"] === "string" ? context["foreignKey"] : pending.descriptor.key;
  const inventoryElicit = params.toolInventoryEntries?.find(
    (entry) => entry.definition.name === correlation.toolName,
  )?.elicits?.[publicKey];
  if (!inventoryElicit) {
    throw new CrankError(
      "interaction_binding_missing",
      `No authored interaction contract exists for elicitation "${publicKey}"`,
    );
  }
  const { responseContract, contextContract } = inventoryElicit;
  const binding = bindingForPending(pending);
  const placement = placementForPending(records, pending, correlation);
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
              bindingId: binding.id,
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

function bindingForPending(pending: PendingElicit) {
  if (!pending.descriptor.binding) {
    throw new CrankError(
      "interaction_binding_missing",
      `Elicitation "${pending.descriptor.key}" parked without an authored binding`,
    );
  }
  try {
    return parseInteractionBinding(pending.descriptor.binding);
  } catch (error) {
    throw new CrankError(
      "interaction_binding_missing",
      `Persisted binding is invalid for elicitation "${pending.descriptor.key}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  authority: JournalAuthorityContract,
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
    return (
      (yield* authority.query({ type: "task.cancellation-state", sessionId, taskId })).type !==
      "none"
    );
  } catch {
    return false;
  }
}

/** Fences only deployments whose native bindings declare fenced activation. */
function* runFencedActivation(
  authority: JournalAuthorityContract,
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

function routeDriverKind(route: ProgramRoute): string {
  if (route === null || typeof route !== "object" || Array.isArray(route)) {
    return "program";
  }
  const kind = route["driverKind"] ?? route["kind"];
  return typeof kind === "string" && kind.length > 0 ? kind : "program";
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

function requireToolRuntime(params: WorkflowChatEngineParams) {
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
