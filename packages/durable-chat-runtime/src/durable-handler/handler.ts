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
import { call, resource, type Operation } from "effection";
import { z } from "zod";
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
import { ModelProviderApi, useModel, useStreamOptions } from "@sweatpants/model-provider";
import {
  ToolInventoryApi,
  ToolRuntimeApi,
  ToolRuntimePort,
  type PortableToolDefinition,
} from "@sweatpants/tool-runtime";
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
import { activitySnapshotsForMessages, toProviderHistorySnapshot } from "@sweatpants/chat-core";
import {
  readLatestConversationCheckpoint,
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
import type { Runtime } from "@sweatpants/model-provider";
import {
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
import { createMemoryHistoryStore } from "@sweatpants/history-store/memory";
import { HistoryStoreApi, installHistoryStore } from "@sweatpants/history-store/port";
import {
  beginTurnPublication,
  completeAndPublishTurn,
  recoverTerminalPublication,
  type RecoveredTurnPublication,
} from "../index.ts";
import { assertJson } from "@sweatpants/foundation";

export { assertPendingResumeConsistency } from "../projection.ts";

const MAX_CHAT_REQUEST_BYTES = 2 * 1024 * 1024;

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

function definitionToToolSchema(definition: PortableToolDefinition): ToolSchema {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  };
}

/**
 * Adapts the model provider serving this Turn to the runtime the engine wants.
 *
 * See `docs/adr/004-turn-scope-and-scope-crossing.md`: the provider is selected
 * per request, but the Turn it serves finishes inside a Host-owned writer task
 * that is deliberately not a child of the request scope. Until a Turn scope
 * exists, the seam must be pinned rather than resolved where the writer runs.
 */
function createRuntimeFromModelProvider(): Runtime {
  return {
    stream(model, context, options) {
      return resource(function* (provide) {
        const stream = yield* ModelProviderApi.operations.stream({
          model,
          context,
          ...(options ? { options } : {}),
        });
        const subscription = yield* stream;
        yield* provide(subscription);
      });
    },
    *generateImages() {
      throw new Error("Model provider runtime adapter does not support image generation");
    },
  };
}

function recoveredPublicationEvents(recovery: RecoveredTurnPublication): ChatEngineSource {
  const capsule = recovery.capsule;
  const event: StreamEvent =
    capsule.disposition === "completed"
      ? {
          type: "RUN_FINISHED",
          threadId: capsule.sessionId,
          runId: capsule.turnId,
          outcome: { type: "success" },
        }
      : {
          type: "RUN_ERROR",
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
  const historyStore = config.historyStore ?? createMemoryHistoryStore();

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
      yield* installHistoryStore(historyStore);
      const selectedActiveExecutionId = (yield* HistoryStoreApi.operations.loadHead(
        requestedConversationId,
      ))?.activeExecutionId;
      const turnOwner: DurableTurnOwner = yield* createDurableTurnOwner(hostOwner, function* () {
        yield* HandlerContext.set(ctx);
        yield* installExecutionStore(executionStore);
        yield* installHistoryStore(historyStore);
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
                const storedConversationCheckpoint = shouldResolveConversation
                  ? yield* readLatestConversationCheckpoint(bufferStore, requestedConversationId)
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
                  storedConversationCheckpoint
                ) {
                  const checkpointEvents = parseStoredCheckpointEvents(
                    storedConversationCheckpoint,
                  );
                  return yield* createStoredConversationCheckpointResponse({
                    ctx,
                    conversationId: requestedConversationId!,
                    checkpointEvents,
                    parsedOffset,
                  });
                }

                const runtime = createRuntimeFromModelProvider();
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
                  // Manual mode
                  if (body.enabledTools === true) {
                    for (const name of inventoryNameList) {
                      enabledToolNames.add(name);
                    }
                  } else if (Array.isArray(body.enabledTools)) {
                    for (const name of body.enabledTools) {
                      if (inventoryNames.has(name)) {
                        enabledToolNames.add(name);
                      }
                    }
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

                // Build model-facing tool schemas through inventory + exposure policy.
                // `enabledPlugins` names match inventory `definition.name` directly because
                // both use the same final tool name from the single generated registry.
                const exposedDefinitions = yield* ToolExposureApi.definitions({
                  phase: "outer-chat",
                  entries: inventoryEntries,
                  request: body,
                  enabledTools: body.enabledTools === true ? true : Array.from(enabledToolNames),
                  enabledPlugins: body.enabledPlugins ?? [],
                  metadata: { sessionId, conversationId: requestedConversationId },
                });

                log.debug(
                  {
                    enabledPlugins: body.enabledPlugins ?? [],
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
                  const recoveredPublication = yield* recoverTerminalPublication(
                    requestedConversationId,
                    projectChatTurnFacts,
                  );
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
                  };
                  let authorityTurn =
                    recoveredPublication || resumePreflightError
                      ? undefined
                      : yield* beginTurnPublication(proposedAuthorityTurn);
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
                          type: "RUN_ERROR",
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
                    authorityTurn = yield* beginTurnPublication(proposedAuthorityTurn);
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
                    runtime,
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
                    ...(plan.effectivePluginAbort && { pluginAbort: plan.effectivePluginAbort }),
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
                    },
                  };
                  const engineSource: ChatEngineSource = recoveredPublication
                    ? recoveredPublicationEvents(recoveredPublication)
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
                            ...(plan.supersedeOpenProgramTurn
                              ? { continueAfterCancellation: true }
                              : {}),
                          });
                  log.debug({ sessionId }, "new session path: chat engine created");

                  // Wrap engine to serialize events
                  const initialReplayState = liveMode === "sse" ? undefined : body.replayState;
                  const initialEvents: StreamEvent[] = resumePreflightError
                    ? [
                        {
                          type: "RUN_ERROR",
                          message: resumePreflightError.message,
                          code: resumePreflightError.code,
                        },
                      ]
                    : [
                        {
                          type: "RUN_STARTED",
                          ...agUiRun,
                          input: {
                            ...agUiRun,
                            state: body.state ?? {},
                            messages: toProviderHistorySnapshot(body.messages, initialReplayState),
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
                                type: "MESSAGES_SNAPSHOT" as const,
                                messages: toProviderHistorySnapshot(
                                  body.messages,
                                  initialReplayState,
                                ),
                              },
                              ...activitySnapshotsForMessages(body.messages, initialReplayState),
                            ]
                          : []),
                        {
                          type: "STATE_SNAPSHOT",
                          snapshot: buildAgUiCustomState({}),
                        },
                      ];
                  // Acquire the one Host-owned response buffer before constructing the
                  // pull source. ProgramRuntime is turned only when this sole writer asks
                  // the engine for its next event; live model activity appends directly
                  // to the same reconnectable buffer from inside that crank turn.
                  log.debug({ sessionId }, "new session path: acquiring session with source");
                  session = yield* registry.acquire(sessionId, {
                    source: (_responseTokenBuffer, responseTokenWriter) =>
                      createSerializedEventStream(engineSource, initialEvents, {
                        ...(clientConversationId ? { conversationId: durableConversationId } : {}),
                        checkpointStore: bufferStore,
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

                if (shouldResolveConversation && method === "GET" && liveMode === undefined) {
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
            type: "RUN_ERROR",
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

const storedCheckpointEventsSchema = z.array(z.record(z.string(), z.json())).max(100_000);

function parseStoredCheckpointEvents(raw: string): StreamEvent[] {
  try {
    const value: unknown = JSON.parse(raw);
    return storedCheckpointEventsSchema.parse(value) as unknown as StreamEvent[];
  } catch {
    throw new CrankError("invalid_chat_request", "Stored conversation checkpoint is malformed");
  }
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
