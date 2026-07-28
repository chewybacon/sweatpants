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
import { call, resource, useScope, type Operation, type Scope } from "effection";
import {
  useSessionRegistryStore,
  useSessionRegistry,
  useTokenBufferStore,
  type SessionHandle,
  type SessionRegistry,
  type TokenBufferStore,
} from "@sweatpants/durable-chat-runtime/response-streams";
import { MaxIterationsContext, PersonaResolverContext } from "../../lib/chat/contexts.ts";
import { ModelProviderPort, useModel, useStreamOptions } from "@sweatpants/chat-core";
import {
  ToolExposureApi,
  ToolInventoryApi,
  ToolRuntimePort,
  type ToolDefinition,
} from "@sweatpants/chat-core";
import { HistoryPolicyContext } from "@sweatpants/chat-core";
import { useLogger } from "../../lib/logger/index.ts";
import {
  bindModel,
  createBindingSource,
  stringParam,
} from "@sweatpants/durable-chat-runtime/handler/model-binder";
import {
  createStreamingHandler,
  useHandlerContext,
} from "@sweatpants/durable-chat-runtime/handler/streaming";
import type { StreamEvent } from "@sweatpants/durable-chat-runtime/handler/types";
import { createProgramDriverChatEngine } from "./program-driver-chat-engine.ts";
import { useOptionalProgramDriverForeignEffects } from "@sweatpants/durable-chat-runtime/program-driver/effects";
import { useOptionalProgramDriverNativeTools } from "./program-driver-native-tools.ts";
import { buildAgUiCustomState } from "@sweatpants/chat-core";
import { activitySnapshotsForMessages, toProviderHistorySnapshot } from "@sweatpants/chat-core";
import {
  readLatestConversationCheckpoint,
  recordConversationSession,
  resolveLatestConversationSession,
} from "@sweatpants/durable-chat-runtime/response-streams";
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
import type { Runtime } from "@sweatpants/chat-core";
import {
  interruptRecordsForThread,
  openInterruptsForThread,
  upsertInterruptRecords,
} from "@sweatpants/durable-chat-runtime/interrupts";
import { resolvePrivateSystemPrompt } from "@sweatpants/durable-chat-runtime/model-context";
import {
  readLatestThreadInterruptState,
  recordThreadInterruptState,
} from "@sweatpants/durable-chat-runtime/interrupts";
import {
  readLatestThreadSystemPrompt,
  recordThreadSystemPrompt,
} from "@sweatpants/durable-chat-runtime/model-context";
import { normalizeChatRequestBody } from "@sweatpants/durable-chat-runtime/handler/request-normalization";
import { planTurn } from "@sweatpants/durable-chat-runtime/handler/turn-plan";
import {
  createEmptyChatEngine,
  createSerializedEventStream,
  type ChatEngineSource,
} from "@sweatpants/durable-chat-runtime/response-streams";
import {
  createConversationHydrateResponse,
  createStoredConversationCheckpointResponse,
} from "@sweatpants/durable-chat-runtime/handler/hydrate-responses";

export { assertPendingResumeConsistency } from "@sweatpants/durable-chat-runtime/projection";

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

function definitionToToolSchema(definition: ToolDefinition): ToolSchema {
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
function createRuntimeFromModelProvider(turnScope: Scope): Runtime {
  // SCOPE-CROSSING (missing node): the chat engine runs in the Host-owned writer
  // task, which outlives the request that selected this model and is not
  // descended from it. Same process, so binding is sound; the Turn scope in
  // ADR-004 removes it. Model inference itself is a network call made by the
  // driver, not a boundary this handle crosses.
  const provider = ModelProviderPort.bind(turnScope);
  return {
    stream(model, context, options) {
      return resource(function* (provide) {
        const stream = yield* provider.stream({
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
          ? normalizeChatRequestBody((yield* call(() => request.json())) as ChatRequestBody)
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

      // Run request-scoped setup before resolving durable dependencies.
      if (setup) {
        yield* setup({ request, body });
      }

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
        const checkpointEvents = JSON.parse(storedConversationCheckpoint) as StreamEvent[];
        return yield* createStoredConversationCheckpointResponse({
          ctx,
          conversationId: requestedConversationId!,
          checkpointEvents,
          parsedOffset,
        });
      }

      const runtime = createRuntimeFromModelProvider(yield* useScope());
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
      // SCOPE-CROSSING (missing node): as above, tool calls are issued by the
      // engine from the writer task, not from this request scope. The runtime
      // resolved here is a local dispatcher; any worker, microVM, or remote tool
      // session lives behind it and crosses by session identity. See ADR-004.
      const activeToolRuntime = toolRuntimeInstalled
        ? ToolRuntimePort.bind(yield* useScope())
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
        toolRuntimeId: activeToolRuntime ? yield* activeToolRuntime.runtimeId() : "program-runtime",
      });

      log.debug(
        { provider: model.provider, model: model.id, api: model.api },
        "model provider configured",
      );

      const inventoryEntries = yield* ToolInventoryApi.list();
      const inventoryNames = new Set(inventoryEntries.map((entry) => entry.definition.name));
      const inventoryNameList = inventoryEntries.map((entry) => entry.definition.name);
      log.debug(
        { toolCount: inventoryEntries.length, toolNames: inventoryNameList },
        "tool inventory configured",
      );

      const resolvePersona = yield* PersonaResolverContext.get();
      const maxIterations = (yield* MaxIterationsContext.get()) ?? maxToolIterations;

      // Get session registry from durable streams context
      log.debug("getting session registry");
      const registry: SessionRegistry<StreamEvent> = yield* useSessionRegistry<StreamEvent>();
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

      const storedSystemPrompt = yield* readLatestThreadSystemPrompt(bufferStore, agUiThreadId);
      systemPrompt = resolvePrivateSystemPrompt(agUiThreadId, storedSystemPrompt ?? systemPrompt);
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
        const programDriverForeignEffects = yield* useOptionalProgramDriverForeignEffects();
        const programDriverNativeTools = yield* useOptionalProgramDriverNativeTools();

        const resumePreflightError =
          plan.resumeValidation && !plan.resumeValidation.ok ? plan.resumeValidation : null;
        const acceptedResume =
          plan.resumeValidation?.ok && !plan.resumeValidation.idempotent
            ? plan.resumeValidation
            : null;

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
          ...(plan.initialToolChoice ? { initialToolChoice: plan.initialToolChoice } : {}),
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
        };
        const engineSource: ChatEngineSource = resumePreflightError
          ? createEmptyChatEngine()
          : (liveEvent) =>
              createProgramDriverChatEngine({
                ...engineParams,
                journalStore: config.programDriverJournalStore,
                liveEvent,
                ...(programDriverForeignEffects
                  ? { foreignEffects: programDriverForeignEffects }
                  : {}),
                ...(programDriverNativeTools ? { nativeTools: programDriverNativeTools } : {}),
                ...(plan.supersedeOpenProgramTurn ? { continueAfterCancellation: true } : {}),
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
                      messages: toProviderHistorySnapshot(body.messages, initialReplayState),
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
            code: "internal_error",
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
