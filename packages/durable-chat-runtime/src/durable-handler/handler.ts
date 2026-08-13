/**
 * Durable Chat Handler
 *
 * A pull-based chat handler that buffers all stream events for:
 * - Client reconnection from last LSN
 * - Multi-client fan-out
 * - Full session replay
 *
 * Protocol:
 * - Request params: sessionId/stream id (query/path), offset (query)
 * - Response: NDJSON with LSN in each event, X-Session-Id + X-Conversation-Id headers
 *
 * Identity law (kernel vs wire vs transport):
 * - conversationId: only durable chat key (crank journal / history / resume)
 * - threadId: AG-UI wire alias of conversationId (always equal on the wire)
 * - runId: ephemeral AG-UI turn correlator (never keys crank state)
 * - sessionId (X-Session-Id): response-stream / reconnect buffer id only
 *
 * This module is the request orchestrator only. The seams it composes:
 * - request-normalization.ts: body/message normalization, resume mapping
 * - turn-plan.ts: pure supersession/resume/elicit decision logic
 * - conversation-projection.ts: internal events -> public wire view
 * - session-event-stream.ts: engine -> Host-owned buffer with persistence
 * - hydrate-responses.ts: checkpoint/buffer replay read responses
 */
import { EventType } from "@ag-ui/core";
import { call, resource, withResolvers, type Operation, type WithResolvers } from "effection";
import { CrankError } from "@sweatpants/durable-execution";
import {
  useSessionRegistryStore,
  useSessionRegistry,
  useTokenBufferStore,
  createDurableTurnOwner,
  type DurableTurnOwner,
  type SessionHandle,
  type SessionRegistry,
  type TokenBufferStore,
} from "../response-streams/index.ts";
import { MaxIterationsContext, PersonaResolverContext } from "../contexts.ts";
import { createChatTurnCompletedFact, projectChatTurnFacts } from "@sweatpants/chat-core";
import { useModel, useStreamOptions } from "@sweatpants/model-provider";
import { ToolInventoryApi, ToolRuntimeApi, ToolRuntimePort } from "@sweatpants/tool-runtime";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import { ToolExposureApi } from "@sweatpants/chat-core";
import { HistoryPolicyContext } from "@sweatpants/chat-core";
import { useLogger } from "../logger/index.ts";
import { bindModel, createBindingSource, stringParam } from "../handler/model-binder.ts";
import { createStreamingHandler, HandlerContext, useHandlerContext } from "../handler/streaming.ts";
import type { StreamEvent } from "../handler/types.ts";
import { createProgramDriverChatEngine } from "./program-driver-chat-engine.ts";
import { manifest as chatProgramManifest } from "./program-driver-schema.ts";
import { useOptionalProgramDriverForeignEffects } from "../program-driver/effects.ts";
import { useOptionalProgramDriverNativeTools } from "../program-driver/native-tools.ts";
import { buildAgUiCustomState } from "@sweatpants/chat-core";
import { toProviderHistorySnapshot } from "@sweatpants/chat-core";
import {
  recordConversationSession,
  resolveLatestConversationSession,
} from "../response-streams/index.ts";
import {
  createEmptyStream,
  createHeadMetadataResponse,
  createProtocolMutationResponse,
  createProtocolReadResponse,
  parseLiveMode,
  parseOffsetParam,
  parseSessionIdFromPath,
  parseTimeoutMs,
} from "@sweatpants/durable-streams";
import type {
  ChatRequestBody,
  DurableChatHandlerConfig,
  ProgramRuntimeChatEngineParams,
  ToolSchema,
} from "./types.ts";
import {
  cancelOpenInterruptsForThread,
  interruptRecordsForThread,
  openInterruptsForThread,
  upsertInterruptRecords,
} from "../interrupts/index.ts";
import { resolvePrivateSystemPrompt } from "../model-context/index.ts";
import { readLatestThreadInterruptState, recordThreadInterruptState } from "../interrupts/index.ts";
import { readLatestThreadSystemPrompt, recordThreadSystemPrompt } from "../model-context/index.ts";
import { parseChatRequestBody } from "../handler/request-normalization.ts";
import { planTurn } from "../handler/turn-plan.ts";
import {
  createEmptyChatEngine,
  createSerializedEventStream,
  type ChatEngineSource,
  type TurnEventSink,
} from "../response-streams/index.ts";
import {
  createConversationHydrateResponse,
  createStoredConversationCheckpointResponse,
} from "../handler/hydrate-responses.ts";
import { useHostScopeOwner } from "../host/host-scope.ts";
import { createMemoryExecutionStore } from "@sweatpants/journal-authority/memory";
import { installExecutionStore } from "@sweatpants/journal-authority/api";
import { createMemoryConversationStore } from "@sweatpants/history-store/memory";
import { ConversationStoreApi, installConversationStore } from "@sweatpants/history-store/port";
import {
  beginTurnPublication,
  completeAndPublishTurn,
  recoverTerminalPublication,
  type RecoveredTurnPublication,
} from "../index.ts";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import {
  hydratePublicRoots,
  persistConversationCheckpoint,
  publicRootIsEvent,
} from "../conversation-persistence.ts";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import { assertJson, stableTupleHash } from "@sweatpants/foundation";
import type { ConversationStore } from "@sweatpants/history-store/contract";
import type { StoredCheckpoint } from "@sweatpants/history-store/contract";

const MAX_CHAT_REQUEST_BYTES = 2 * 1024 * 1024;
let responseWriterEpoch = 1;

function nextResponseWriterFence(sessionId: string): {
  ownerId: string;
  activationEpoch: number;
} {
  // Millisecond clock space leaves room for process-local activations while
  // remaining below Number.MAX_SAFE_INTEGER. The buffer itself rejects stale
  // competing claims.
  responseWriterEpoch = Math.max(responseWriterEpoch + 1, Date.now() * 1_000);
  return {
    ownerId: stableTupleHash(["response-writer", process.pid, sessionId, responseWriterEpoch]),
    activationEpoch: responseWriterEpoch,
  };
}

// =============================================================================
// PROTOCOL PARAMETER BINDER
// =============================================================================

/**
 * Binder for durable stream protocol parameters.
 */
const durableParamsBinder = bindModel({
  sessionId: stringParam("x-unused-session-id", "sessionId"),
  conversationId: stringParam("x-conversation-id", "conversationId"),
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function* eventsFromCheckpoint(
  store: ConversationStore,
  conversationId: string,
  checkpoint: StoredCheckpoint,
): Operation<StreamEvent[]> {
  const roots = yield* hydratePublicRoots(store, conversationId, checkpoint);
  return roots.filter(publicRootIsEvent) as StreamEvent[];
}

function definitionToToolSchema(definition: ChatToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description ?? "",
    parameters: definition.parameters,
  };
}

function recoveredPublicationEvents(recovery: RecoveredTurnPublication): ChatEngineSource {
  const capsule = recovery.capsule;
  const event: StreamEvent =
    capsule.disposition === "completed"
      ? {
          type: EventType.RUN_FINISHED,
          threadId: capsule.sessionId,
          runId: capsule.turnId,
          outcome: { type: "success" },
        }
      : {
          type: EventType.RUN_ERROR,
          code: `PROGRAM_${capsule.disposition.toUpperCase()}`,
          message: `Program ${capsule.disposition}`,
        };
  return resource(function* (provide) {
    let emitted = false;
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        if (emitted) return { done: true, value: undefined };
        emitted = true;
        return { done: false, value: event };
      },
    });
  });
}

interface LiveProgramActivation {
  readonly executionId: string;
  readonly taskReady: WithResolvers<string>;
  readonly terminal: WithResolvers<void>;
}

function createLiveProgramActivation(executionId: string): LiveProgramActivation {
  return {
    executionId,
    taskReady: withResolvers(`live task ${executionId} ready`),
    terminal: withResolvers(`live task ${executionId} terminal`),
  };
}

function createLiveCancellationEngine(params: {
  journalStore: DurableChatHandlerConfig["programDriverJournalStore"];
  activation: LiveProgramActivation;
  conversationId: string;
  reason: string;
}): ChatEngineSource {
  return resource(function* (provide) {
    let emitted = false;
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        if (emitted) return { done: true, value: undefined };
        emitted = true;
        const taskId = yield* params.activation.taskReady.operation;
        const journal = yield* params.journalStore.open(params.conversationId);
        yield* journal.requestCancellation(params.conversationId, taskId, params.reason);
        // The original Host-owned activation performs the unwind and terminal
        // publication. This command only signals and joins it.
        yield* params.activation.terminal.operation;
        return {
          done: false,
          value: {
            type: EventType.RUN_ERROR,
            code: "PROGRAM_CANCELLED",
            message: params.reason,
          },
        };
      },
    });
  });
}

function* restoreThreadInterruptStateIfNeeded(
  bufferStore: TokenBufferStore<string>,
  threadId: string | undefined,
): Operation<void> {
  if (!threadId) {
    return;
  }
  const stored = yield* readLatestThreadInterruptState(bufferStore, threadId);
  if (!stored || stored.length === 0) {
    return;
  }
  upsertInterruptRecords(stored);
}

// =============================================================================
// DURABLE CHAT HANDLER
// =============================================================================

/**
 * Create a durable chat handler.
 *
 * The handler:
 * 1. Binds protocol params from request (sessionId, offset)
 * 2. Runs request setup to set up DI contexts
 * 3. Either reconnects to existing session or creates new one
 * 4. Streams events from buffer to response with LSN
 *
 * @param config - Handler configuration
 * @returns Fetch handler function
 */
export function createDurableChatHandler(config: DurableChatHandlerConfig) {
  const { setup, maxToolIterations = 10 } = config;
  const executionStore = config.executionStore ?? createMemoryExecutionStore();
  const conversationStore = config.conversationStore ?? createMemoryConversationStore();
  const checkpointTargets = config.storageProfile === "low" ? LOW_CHECKPOINT_TARGETS : undefined;
  const liveProgramActivations = new Map<string, LiveProgramActivation>();

  return createStreamingHandler(
    function* () {
      const ctx = yield* useHandlerContext();
      const request = ctx.request;
      const bindingSource = createBindingSource(request);
      const pathSessionId = parseSessionIdFromPath(new URL(request.url).pathname);
      const { sessionId: requestedSessionId, conversationId: requestedConversationIdParam } =
        durableParamsBinder(bindingSource);
      const parsedOffset = parseOffsetParam(bindingSource.searchParams.get("offset"));
      const liveMode = parseLiveMode(bindingSource.searchParams.get("live"));
      const timeoutMs = parseTimeoutMs(bindingSource.searchParams.get("timeout"));
      const method = request.method.toUpperCase();
      const isProtocolMutation =
        pathSessionId !== undefined &&
        (method === "PUT" || method === "POST" || method === "DELETE");

      // Parse request body for mutating requests only.
      const body =
        request.method === "POST" && !isProtocolMutation
          ? parseChatRequestBody(yield* readBoundedChatRequest(request))
          : ({ messages: [] } as ChatRequestBody);

      // Durable conversation identity resolution:
      //   1. explicit conversationId (body)
      //   2. conversationId query/header
      //   3. AG-UI threadId as alias
      //   4. server-minted id (returned via X-Conversation-Id)
      // Divergent body.threadId never forks identity once conversationId is set.
      const clientConversationId =
        body.conversationId?.trim() ||
        requestedConversationIdParam?.trim() ||
        body.threadId?.trim() ||
        undefined;
      const requestedConversationId = clientConversationId ?? crypto.randomUUID();

      const hostOwner = yield* useHostScopeOwner();
      if (!hostOwner) {
        throw new Error("Durable chat requests require an explicit Host-owned Turn scope");
      }
      // Select the authority-visible active Turn after normalization and before
      // constructing its structural owner. This read never starts durable work.
      yield* installExecutionStore(executionStore);
      yield* installConversationStore(conversationStore);
      const selectedHead = yield* ConversationStoreApi.operations.loadHead(requestedConversationId);
      const selectedActiveExecutionId = selectedHead?.activeExecutionId;
      const turnOwner: DurableTurnOwner = yield* createDurableTurnOwner(hostOwner, function* () {
        yield* HandlerContext.set(ctx);
        yield* installExecutionStore(executionStore);
        yield* installConversationStore(conversationStore);
        if (setup) {
          yield* setup({ request, body });
        }
      });
      let requestSetupCompleted = false;
      try {
        const attempt = yield* call(() =>
          turnOwner.scope.run(function* () {
            try {
              const value = yield* (function* () {
                const bufferStore = yield* useTokenBufferStore<string>();
                yield* restoreThreadInterruptStateIfNeeded(bufferStore, requestedConversationId);
                const shouldResolveConversation =
                  requestedConversationId !== undefined &&
                  pathSessionId === undefined &&
                  requestedSessionId === undefined &&
                  method !== "POST";
                const resolvedConversationSessionId = shouldResolveConversation
                  ? yield* resolveLatestConversationSession(bufferStore, requestedConversationId)
                  : null;
                const resolvedHead = shouldResolveConversation
                  ? yield* conversationStore.loadHead(requestedConversationId)
                  : null;
                const storedConversationCheckpoint =
                  shouldResolveConversation && resolvedHead?.checkpoint
                    ? yield* conversationStore.getCheckpoint(resolvedHead.checkpoint)
                    : null;
                if (
                  shouldResolveConversation &&
                  !resolvedConversationSessionId &&
                  !storedConversationCheckpoint
                ) {
                  ctx.status = 404;
                  return yield* createEmptyStream();
                }

                // Response-stream id (transport reconnect buffer). Not durable chat state.
                // Prefer path/query stream ids, then conversation→stream index, else mint.
                const sessionId =
                  pathSessionId ??
                  requestedSessionId ??
                  resolvedConversationSessionId ??
                  (storedConversationCheckpoint ? requestedConversationId! : crypto.randomUUID());
                const isReconnect =
                  (pathSessionId !== undefined ||
                    requestedSessionId !== undefined ||
                    requestedConversationId !== undefined) &&
                  (parsedOffset.value !== null || parsedOffset.isNow);
                const startLSN = parsedOffset.value ?? 0;

                // Set response headers
                // X-Session-Id = response stream / reconnect buffer id (transport)
                // X-Conversation-Id = durable conversation key (kernel)
                ctx.headers.set("X-Session-Id", sessionId);
                ctx.headers.set("X-Conversation-Id", requestedConversationId);
                ctx.headers.set("Cache-Control", "no-store");

                // Get logger after hooks run (so setupLogger has executed)
                const log = yield* useLogger("handler:durable");
                log.debug(
                  {
                    sessionId,
                    conversationId: requestedConversationId,
                    resolvedConversationSessionId,
                    method,
                    isReconnect,
                    startLSN,
                    messageCount: body.messages.length,
                  },
                  "request received",
                );

                if (isProtocolMutation) {
                  const registryStore = yield* useSessionRegistryStore();

                  return yield* createProtocolMutationResponse({
                    ctx,
                    sessionId,
                    method: method as "PUT" | "POST" | "DELETE",
                    bufferStore,
                    registryStore,
                    log,
                  });
                }

                if (
                  shouldResolveConversation &&
                  !resolvedConversationSessionId &&
                  storedConversationCheckpoint &&
                  !resolvedHead?.activeExecutionId
                ) {
                  const checkpointEvents = yield* eventsFromCheckpoint(
                    conversationStore,
                    requestedConversationId!,
                    storedConversationCheckpoint,
                  );
                  return yield* createStoredConversationCheckpointResponse({
                    ctx,
                    conversationId: requestedConversationId!,
                    checkpointEvents,
                    parsedOffset,
                  });
                }

                const model = yield* useModel();
                const contextStreamOptions = yield* useStreamOptions();
                const streamOptions =
                  contextStreamOptions || body.streamOptions
                    ? { ...contextStreamOptions, ...body.streamOptions }
                    : undefined;
                // conversationId is the only durable chat key. threadId is always its
                // AG-UI alias. runId is request-scoped and must never fall back to the
                // response-stream id (sessionId).
                const durableConversationId = requestedConversationId;
                const agUiThreadId = durableConversationId;
                yield* restoreThreadInterruptStateIfNeeded(bufferStore, agUiThreadId);
                const agUiRunId = body.runId?.trim() || crypto.randomUUID();

                // The tool runtime seam is optional, so presence is probed here.
                const toolRuntimeInstalled = yield* ToolRuntimePort.isInstalled();
                const activeToolRuntime = toolRuntimeInstalled
                  ? ToolRuntimeApi.operations
                  : undefined;
                // F5: resolve the optional history policy in request scope; the engine
                // runs in a background writer task without these contexts.
                const historyPolicy = yield* HistoryPolicyContext.get();
                // Resume validation is pure. Interrupt state is committed only after the
                // crank respond commands are durably accepted by the adapter.
                const plan = planTurn({
                  body,
                  method,
                  threadId: agUiThreadId,
                  runId: agUiRunId,
                  openInterrupts: openInterruptsForThread(agUiThreadId),
                  toolRuntimeId: activeToolRuntime
                    ? yield* activeToolRuntime.runtimeId()
                    : "program-runtime",
                });
                const selectedLiveActivation = liveProgramActivations.get(requestedConversationId);
                const cancelReason = plan.effectivePluginAbort?.reason ?? "Program was cancelled";
                const hostCancelParkedOrOrphaned =
                  Boolean(plan.effectivePluginAbort) &&
                  !plan.supersedeOpenProgramTurn &&
                  Boolean(selectedActiveExecutionId) &&
                  selectedLiveActivation?.executionId !== selectedActiveExecutionId;
                if (hostCancelParkedOrOrphaned && selectedActiveExecutionId) {
                  const existing =
                    yield* TurnJournalAuthority.operations.read(selectedActiveExecutionId);
                  if (existing && existing.format !== "sweatpants.terminal-execution.v1") {
                    const cancelledOutcome = {
                      code: "PROGRAM_CANCELLED",
                      message: cancelReason,
                    };
                    yield* completeAndPublishTurn({
                      executionId: selectedActiveExecutionId,
                      outcome: { storage: "inline", value: cancelledOutcome },
                      disposition: cancelReason.includes("supersede") ? "superseded" : "cancelled",
                      completedAt: Date.now(),
                      facts: [
                        createChatTurnCompletedFact({
                          executionId: existing.executionId,
                          sessionId: existing.sessionId,
                          turnId: existing.turnId,
                          outcome: cancelledOutcome,
                          events: [
                            {
                              type: EventType.RUN_ERROR,
                              code: cancelledOutcome.code,
                              message: cancelledOutcome.message,
                            },
                          ],
                        }),
                      ],
                      project: projectChatTurnFacts,
                    });
                  }
                  cancelOpenInterruptsForThread(agUiThreadId);
                  selectedLiveActivation?.terminal.resolve(undefined);
                  if (
                    liveProgramActivations.get(requestedConversationId) === selectedLiveActivation
                  ) {
                    liveProgramActivations.delete(requestedConversationId);
                  }
                }
                const liveCancellation =
                  plan.effectivePluginAbort &&
                  !plan.supersedeOpenProgramTurn &&
                  !hostCancelParkedOrOrphaned &&
                  selectedActiveExecutionId &&
                  selectedLiveActivation?.executionId === selectedActiveExecutionId
                    ? {
                        activation: selectedLiveActivation,
                        reason: cancelReason,
                      }
                    : null;

                // An exact retry of an already-settled resume is a durable no-op.
                // Replay the committed conversation checkpoint instead of creating
                // another provider turn. Conflicting settled responses remain
                // preflight errors below.
                if (plan.resumeValidation?.ok && plan.resumeValidation.idempotent) {
                  const idempotentHead = yield* conversationStore.loadHead(requestedConversationId);
                  const idempotentCheckpoint = idempotentHead?.checkpoint
                    ? yield* conversationStore.getCheckpoint(idempotentHead.checkpoint)
                    : null;
                  if (!idempotentCheckpoint) {
                    throw new CrankError(
                      "invalid_chat_request",
                      "Settled resume cannot be replayed because its conversation checkpoint is missing",
                    );
                  }
                  const checkpointEvents = yield* eventsFromCheckpoint(
                    conversationStore,
                    requestedConversationId,
                    idempotentCheckpoint,
                  );
                  return yield* createStoredConversationCheckpointResponse({
                    ctx,
                    conversationId: requestedConversationId,
                    checkpointEvents,
                    parsedOffset,
                    terminalRunId: agUiRunId,
                  });
                }

                log.debug(
                  { provider: model.provider, model: model.id, api: model.api },
                  "model provider configured",
                );

                const inventoryEntries = yield* ToolInventoryApi.list();
                const inventoryNames = new Set(
                  inventoryEntries.map((entry) => entry.definition.name),
                );
                const inventoryNameList = inventoryEntries.map((entry) => entry.definition.name);
                log.debug(
                  { toolCount: inventoryEntries.length, toolNames: inventoryNameList },
                  "tool inventory configured",
                );

                const resolvePersona = yield* PersonaResolverContext.get();
                const maxIterations = (yield* MaxIterationsContext.get()) ?? maxToolIterations;

                // Get session registry from durable streams context
                log.debug("getting session registry");
                const registry: SessionRegistry<StreamEvent> =
                  yield* useSessionRegistry<StreamEvent>();
                log.debug("session registry acquired");

                // Build tool schemas
                const enabledToolNames = new Set<string>();
                let exposeCompleteInventory = false;
                let systemPrompt: string | undefined;

                // Handle persona mode vs manual mode
                if (body.persona) {
                  if (!resolvePersona) {
                    throw new Error("Persona mode not supported - no resolver configured");
                  }

                  const resolved = resolvePersona(
                    body.persona,
                    body.personaConfig,
                    body.enableOptionalTools,
                    body.effort,
                  );

                  systemPrompt = resolved.systemPrompt;

                  for (const toolName of resolved.tools) {
                    if (inventoryNames.has(toolName)) {
                      enabledToolNames.add(toolName);
                    } else {
                      throw new Error(`Unknown persona tool: ${toolName}`);
                    }
                  }
                } else {
                  // Manual mode presents the complete inventory installed by the
                  // Host. Client plugins and wire metadata never select inventory.
                  exposeCompleteInventory = true;
                  for (const name of inventoryNameList) {
                    enabledToolNames.add(name);
                  }

                  if (body.systemPrompt) {
                    systemPrompt = body.systemPrompt;
                  }
                }

                const storedSystemPrompt = yield* readLatestThreadSystemPrompt(
                  bufferStore,
                  agUiThreadId,
                );
                systemPrompt = resolvePrivateSystemPrompt(
                  agUiThreadId,
                  storedSystemPrompt ?? systemPrompt,
                );
                if (systemPrompt && storedSystemPrompt == null) {
                  yield* recordThreadSystemPrompt(bufferStore, agUiThreadId, systemPrompt);
                }

                // Build model-facing tool schemas through server inventory + exposure policy.
                // Client plugin registration never participates in executable selection.
                const exposedDefinitions = yield* ToolExposureApi.definitions({
                  phase: "outer-chat",
                  entries: inventoryEntries,
                  request: body,
                  // This is a Host-selected presentation set. Authorization still
                  // comes from `entries`, the scoped executable inventory.
                  enabledTools: exposeCompleteInventory ? true : Array.from(enabledToolNames),
                  metadata: { sessionId, conversationId: requestedConversationId },
                });

                log.debug(
                  {
                    exposedToolNames: exposedDefinitions.map((definition) => definition.name),
                  },
                  "tool exposure resolved",
                );

                const seenNames = new Set<string>();
                const toolSchemas: ToolSchema[] = [];
                for (const schema of exposedDefinitions.map(definitionToToolSchema)) {
                  if (!seenNames.has(schema.name)) {
                    seenNames.add(schema.name);
                    toolSchemas.push(schema);
                  }
                }

                let session: SessionHandle<StreamEvent>;

                // Debug: log which path we're taking and if we have elicit responses
                log.debug(
                  {
                    sessionId,
                    isReconnect,
                    hasElicitResponses: plan.effectiveElicitResponses.length > 0,
                    elicitResponseCount: plan.effectiveElicitResponses.length,
                  },
                  "determining path",
                );

                if (method === "HEAD") {
                  log.debug({ sessionId }, "head request");
                  return yield* createHeadMetadataResponse(ctx, registry, sessionId, startLSN);
                }

                if (isReconnect) {
                  // RECONNECT PATH: Acquire existing session, stream from buffer at offset
                  log.debug({ sessionId, startLSN }, "reconnect path: acquiring existing session");
                  session = yield* registry.acquire(sessionId);
                  log.debug({ sessionId }, "reconnect path: session acquired");
                } else {
                  // NEW SESSION PATH: Create engine, stream to buffer, then to response
                  log.debug({ sessionId }, "new session path: creating chat engine");

                  const agUiRun = {
                    threadId: agUiThreadId,
                    runId: agUiRunId,
                    ...(body.parentRunId ? { parentRunId: body.parentRunId } : {}),
                  };
                  const resumePreflightError =
                    plan.resumeValidation && !plan.resumeValidation.ok
                      ? plan.resumeValidation
                      : null;
                  const acceptedResume =
                    plan.resumeValidation?.ok && !plan.resumeValidation.idempotent
                      ? plan.resumeValidation
                      : null;
                  const recoveredPublicationCandidate = yield* recoverTerminalPublication(
                    requestedConversationId,
                    projectChatTurnFacts,
                  );
                  // A recovered publication belongs to the request that originally
                  // created its run. If this is a newer client command, the recovery
                  // side effect above is still required, but it must not replace the
                  // newer model turn with the old terminal replay.
                  const recoveredPublication =
                    recoveredPublicationCandidate?.capsule.turnId === agUiRunId
                      ? recoveredPublicationCandidate
                      : null;
                  if (
                    selectedActiveExecutionId &&
                    recoveredPublication &&
                    recoveredPublication.capsule.executionId !== selectedActiveExecutionId
                  ) {
                    throw new Error("Recovered publication differs from the selected active Turn");
                  }
                  const proposedAuthorityTurn = {
                    executionId: `chat-turn:${requestedConversationId}:${agUiRunId}`,
                    sessionId: requestedConversationId,
                    turnId: agUiRunId,
                    rootTaskId: `${agUiRunId}/root`,
                    rootProgram: {
                      id: chatProgramManifest.programId,
                      version: chatProgramManifest.version,
                      digest: chatProgramManifest.digest,
                    },
                    commandId:
                      body.messageId?.trim() ||
                      body.runId?.trim() ||
                      stableTupleHash([body.trigger ?? "submit-message", body.messages]),
                    commandDigest: stableTupleHash([
                      body.trigger ?? "submit-message",
                      body.messages,
                      body.systemPrompt ?? null,
                      body.resume ?? null,
                    ]),
                    participantId: body.clientId?.trim() || "chat-client",
                    acceptedAt: Date.now(),
                    retainUntil: Date.now() + 30 * 24 * 60 * 60 * 1_000,
                    admission: (plan.resumeValidation?.ok ||
                    method === "GET" ||
                    liveCancellation ||
                    plan.supersedeOpenProgramTurn
                      ? "join-active"
                      : "send-message") as "send-message" | "join-active",
                  };
                  let authorityTurn =
                    recoveredPublication ||
                    resumePreflightError ||
                    liveCancellation ||
                    hostCancelParkedOrOrphaned
                      ? undefined
                      : yield* beginTurnPublication(proposedAuthorityTurn);
                  let supersededInHandler = false;
                  if (
                    authorityTurn &&
                    plan.supersedeOpenProgramTurn &&
                    authorityTurn.executionId !== proposedAuthorityTurn.executionId
                  ) {
                    const supersededOutcome = {
                      code: "PROGRAM_SUPERSEDED",
                      message: "Program was superseded by a newer ordinary Turn",
                    };
                    const fact = createChatTurnCompletedFact({
                      executionId: authorityTurn.executionId,
                      sessionId: authorityTurn.sessionId,
                      turnId: authorityTurn.turnId,
                      outcome: supersededOutcome,
                      events: [
                        {
                          type: EventType.RUN_ERROR,
                          code: supersededOutcome.code,
                          message: supersededOutcome.message,
                        },
                      ],
                    });
                    yield* completeAndPublishTurn({
                      executionId: authorityTurn.executionId,
                      outcome: { storage: "inline", value: supersededOutcome },
                      disposition: "superseded",
                      completedAt: Date.now(),
                      facts: [fact],
                      project: projectChatTurnFacts,
                    });
                    supersededInHandler = true;
                    authorityTurn = yield* beginTurnPublication({
                      ...proposedAuthorityTurn,
                      admission: "send-message",
                    });
                  }
                  const liveActivation = authorityTurn
                    ? createLiveProgramActivation(authorityTurn.executionId)
                    : null;
                  if (liveActivation) {
                    liveProgramActivations.set(requestedConversationId, liveActivation);
                  }
                  const programDriverForeignEffects =
                    yield* useOptionalProgramDriverForeignEffects();
                  const programDriverNativeTools = yield* useOptionalProgramDriverNativeTools();

                  // Create the chat engine. If public resume validation failed, use an
                  // empty engine and expose the failure as a schema-valid RUN_ERROR before
                  // any replay projection or runtime continuation can occur.
                  const engineParams: ProgramRuntimeChatEngineParams = {
                    messages: body.messages,
                    ...(systemPrompt !== undefined && { systemPrompt }),
                    toolSchemas,
                    model,
                    ...(streamOptions ? { streamOptions } : {}),
                    ...(plan.initialToolChoice
                      ? { initialToolChoice: plan.initialToolChoice }
                      : {}),
                    toolInventoryEntries: inventoryEntries,
                    ...(activeToolRuntime ? { toolRuntime: activeToolRuntime } : {}),
                    ...(historyPolicy ? { historyPolicy } : {}),
                    maxIterations,
                    conversationId: requestedConversationId,
                    agUiRun,
                    onLiveTaskReady(taskId): void {
                      liveActivation?.taskReady.resolve(taskId);
                    },
                    onLiveActivationSettled(error): void {
                      const failure =
                        error ?? new Error("Live activation settled before terminal publication");
                      liveActivation?.taskReady.reject(failure);
                      liveActivation?.terminal.reject(failure);
                      if (liveProgramActivations.get(requestedConversationId) === liveActivation) {
                        liveProgramActivations.delete(requestedConversationId);
                      }
                    },
                    ...(shouldResolveConversation && method === "GET"
                      ? { recoveryOnly: true }
                      : {}),
                    ...(plan.effectiveElicitResponses.length > 0 && {
                      elicitResponses: plan.effectiveElicitResponses,
                    }),
                    ...(acceptedResume
                      ? {
                          onResumeAccepted: function* (): Operation<void> {
                            upsertInterruptRecords(acceptedResume.records);
                            yield* recordThreadInterruptState(
                              bufferStore,
                              agUiThreadId,
                              interruptRecordsForThread(agUiThreadId),
                            );
                          },
                        }
                      : {}),
                    ...(plan.effectivePluginAbort &&
                      !supersededInHandler && { pluginAbort: plan.effectivePluginAbort }),
                    publishCheckpoint: function* ({ events }): Operation<void> {
                      if (!authorityTurn) return;
                      const parkedHead = yield* conversationStore.loadHead(requestedConversationId);
                      if (
                        !parkedHead ||
                        parkedHead.activeExecutionId !== authorityTurn.executionId
                      ) {
                        return;
                      }
                      const encodedEvents = events.map((event) => assertJson(event));
                      yield* persistConversationCheckpoint(conversationStore, {
                        conversationId: requestedConversationId,
                        causeKey: stableTupleHash([
                          authorityTurn.executionId,
                          "parked",
                          encodedEvents,
                        ]),
                        cause: {
                          kind: "tail-cut",
                          cutKind: "parked",
                          executionId: authorityTurn.executionId,
                          logicalTurnId: authorityTurn.turnId,
                        },
                        roots: encodedEvents,
                        ...(checkpointTargets ? { targets: checkpointTargets } : {}),
                        expectedRevision: parkedHead.revision,
                        expectedOwnerEpoch: parkedHead.ownerEpoch,
                        expectedExecutionId: authorityTurn.executionId,
                        sealedRootCount: encodedEvents.length,
                        proposal: {
                          state: "parked",
                          terminalHistory: parkedHead.terminalHistory,
                          activeLogicalTurnId: parkedHead.activeLogicalTurnId,
                          activeExecutionId: parkedHead.activeExecutionId,
                          latestCompletedExecutionId: parkedHead.latestCompletedExecutionId,
                          activeSegment: parkedHead.activeSegment,
                          activeCommand: parkedHead.activeCommand,
                          deletedAt: parkedHead.deletedAt,
                        },
                        createdAt: Date.now(),
                      });
                    },
                    publishTerminal: function* ({ outcome, disposition, events }): Operation<void> {
                      if (!authorityTurn) {
                        throw new Error(
                          "Recovered terminal publication cannot execute ProgramRuntime",
                        );
                      }
                      const fact = createChatTurnCompletedFact({
                        executionId: authorityTurn.executionId,
                        sessionId: authorityTurn.sessionId,
                        turnId: authorityTurn.turnId,
                        outcome,
                        events: events.map((event) => assertJson(event)),
                      });
                      yield* completeAndPublishTurn({
                        executionId: authorityTurn.executionId,
                        outcome: { storage: "inline", value: outcome },
                        disposition,
                        completedAt: Date.now(),
                        facts: [fact],
                        project: projectChatTurnFacts,
                      });
                      liveActivation?.terminal.resolve(undefined);
                    },
                  };
                  const engineSource: ChatEngineSource = liveCancellation
                    ? createLiveCancellationEngine({
                        journalStore: config.programDriverJournalStore,
                        activation: liveCancellation.activation,
                        conversationId: requestedConversationId,
                        reason: liveCancellation.reason ?? "Program was cancelled",
                      })
                    : hostCancelParkedOrOrphaned || recoveredPublication
                      ? hostCancelParkedOrOrphaned
                        ? createEmptyChatEngine()
                        : recoveredPublicationEvents(recoveredPublication!)
                      : resumePreflightError
                        ? createEmptyChatEngine()
                        : (liveEvent: TurnEventSink) =>
                            createProgramDriverChatEngine({
                              ...engineParams,
                              journalStore: config.programDriverJournalStore,
                              liveEvent,
                              ...(programDriverForeignEffects
                                ? { foreignEffects: programDriverForeignEffects }
                                : {}),
                              ...(programDriverNativeTools
                                ? { nativeTools: programDriverNativeTools }
                                : {}),
                              ...(plan.supersedeOpenProgramTurn && !supersededInHandler
                                ? { continueAfterCancellation: true }
                                : {}),
                            });
                  log.debug({ sessionId }, "new session path: chat engine created");

                  // Wrap engine to serialize events. A replacement Host must
                  // seed a recovery stream from the authoritative checkpoint
                  // before appending newly projected journal deltas; otherwise
                  // reconnect consumers can observe tool/activity updates
                  // without their registered parents.
                  const recoveryCheckpointEvents =
                    shouldResolveConversation && method === "GET" && storedConversationCheckpoint
                      ? yield* eventsFromCheckpoint(
                          conversationStore,
                          requestedConversationId,
                          storedConversationCheckpoint,
                        )
                      : null;
                  const initialEvents: StreamEvent[] =
                    recoveryCheckpointEvents ??
                    (hostCancelParkedOrOrphaned
                      ? [
                          {
                            type: EventType.RUN_ERROR,
                            message: cancelReason,
                            code: "PROGRAM_CANCELLED",
                          },
                        ]
                      : resumePreflightError
                        ? [
                            {
                              type: EventType.RUN_ERROR,
                              message: resumePreflightError.message,
                              code: resumePreflightError.code,
                            },
                          ]
                        : [
                            {
                              type: EventType.RUN_STARTED,
                              ...agUiRun,
                              input: {
                                ...agUiRun,
                                state: body.state ?? {},
                                messages: toProviderHistorySnapshot(body.messages),
                                tools: toolSchemas.map((tool) => ({
                                  name: tool.name,
                                  description: tool.description,
                                  parameters: tool.parameters,
                                })),
                                context: body.context ?? [],
                                forwardedProps: body.forwardedProps ?? {},
                                ...(body.resume ? { resume: body.resume } : {}),
                              },
                            },
                            ...(body.messages.length > 0
                              ? [
                                  {
                                    type: EventType.MESSAGES_SNAPSHOT as const,
                                    messages: toProviderHistorySnapshot(body.messages),
                                  },
                                ]
                              : []),
                            {
                              type: EventType.STATE_SNAPSHOT,
                              snapshot: buildAgUiCustomState({}),
                            },
                          ]);

                  if (
                    authorityTurn &&
                    authorityTurn.executionId === proposedAuthorityTurn.executionId &&
                    !recoveredPublication &&
                    !resumePreflightError
                  ) {
                    const runningHead = yield* conversationStore.loadHead(requestedConversationId);
                    if (runningHead) {
                      yield* persistConversationCheckpoint(conversationStore, {
                        conversationId: requestedConversationId,
                        causeKey: stableTupleHash([
                          authorityTurn.executionId,
                          "nonterminal",
                          initialEvents.map((event) => assertJson(event)),
                        ]),
                        cause: {
                          kind: "tail-cut",
                          cutKind: "rolling",
                          executionId: authorityTurn.executionId,
                          logicalTurnId: authorityTurn.turnId,
                        },
                        roots: initialEvents.map((event) => assertJson(event)),
                        ...(checkpointTargets ? { targets: checkpointTargets } : {}),
                        expectedRevision: runningHead.revision,
                        expectedOwnerEpoch: runningHead.ownerEpoch,
                        expectedExecutionId: authorityTurn.executionId,
                        sealedRootCount: 0,
                        proposal: {
                          state: runningHead.state,
                          terminalHistory: runningHead.terminalHistory,
                          activeLogicalTurnId: runningHead.activeLogicalTurnId,
                          activeExecutionId: runningHead.activeExecutionId,
                          latestCompletedExecutionId: runningHead.latestCompletedExecutionId,
                          activeSegment: runningHead.activeSegment,
                          activeCommand: runningHead.activeCommand,
                          deletedAt: runningHead.deletedAt,
                        },
                        createdAt: Date.now(),
                      });
                    }
                  }

                  // Acquire the one Host-owned response buffer before constructing the
                  // pull source. ProgramRuntime is turned only when this sole writer asks
                  // the engine for its next event; live model activity appends directly
                  // to the same reconnectable buffer from inside that crank turn.
                  log.debug({ sessionId }, "new session path: acquiring session with source");
                  session = yield* registry.acquire(sessionId, {
                    writer: nextResponseWriterFence(sessionId),
                    recoverIfDetached: shouldResolveConversation,
                    source: (_responseTokenBuffer, responseTokenWriter) =>
                      createSerializedEventStream(engineSource, initialEvents, {
                        ...(clientConversationId ? { conversationId: durableConversationId } : {}),
                        responseTokenBuffer: responseTokenWriter,
                      }),
                  });
                  log.debug({ sessionId }, "new session path: session acquired");
                }

                // Only record the conversation session index when the client explicitly
                // provided a conversationId. When the server minted one (client didn't
                // send one), the index is recorded on the next request when the client
                // sends the minted id back (received from the X-Conversation-Id header).
                if (clientConversationId && method === "POST") {
                  yield* recordConversationSession(bufferStore, durableConversationId, sessionId);
                }

                if (
                  shouldResolveConversation &&
                  method === "GET" &&
                  liveMode === undefined &&
                  !resolvedHead?.activeExecutionId
                ) {
                  return yield* createConversationHydrateResponse({
                    ctx,
                    registry,
                    session,
                    sessionId,
                    conversationId: requestedConversationId!,
                    parsedOffset,
                  });
                }

                return yield* createProtocolReadResponse({
                  ctx,
                  registry,
                  session,
                  sessionId,
                  startLSN,
                  isReconnect,
                  parsedOffset,
                  liveMode,
                  timeoutMs,
                  log,
                });
              })();
              return { ok: true as const, value };
            } catch (error) {
              return { ok: false as const, error };
            }
          }),
        );
        if (!attempt.ok) {
          throw attempt.error;
        }
        requestSetupCompleted = true;
        return attempt.value;
      } finally {
        if (requestSetupCompleted) {
          turnOwner.seal();
        } else {
          yield* turnOwner.abort();
        }
      }
    },
    {
      defaultHeaders: {
        "Content-Type": "application/x-ndjson",
      },
      serialize: (v) => v + "\n",
      onSetupError: (error, ctx) => {
        // Return NDJSON error event instead of plain JSON
        const errorEvent = {
          lsn: 0,
          event: {
            type: EventType.RUN_ERROR,
            message: error.message,
            code: error instanceof CrankError ? error.code : "internal_error",
          },
        };
        const body = JSON.stringify(errorEvent) + "\n";
        return new Response(body, {
          status: 200, // Stream "succeeded" but contains error event
          headers: ctx.headers,
        });
      },
    },
  );
}

function* readBoundedChatRequest(request: Request): Operation<unknown> {
  if (!request.body) {
    return {};
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = yield* call(() => reader.read());
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_CHAT_REQUEST_BYTES) {
        yield* call(() => reader.cancel());
        throw new CrankError("payload_too_large", "Chat request body exceeds the 2 MiB limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new CrankError("invalid_chat_request", "Chat request body must be valid JSON");
  }
}
