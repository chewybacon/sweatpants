import { EventType } from "@ag-ui/core";
import {
  type ConversationStreamEvent as StreamEvent,
  HistoryPolicyContext,
  projectChatTurnFacts,
  toProviderHistorySnapshot,
} from "@sweatpants/chat-core";
import { CrankError } from "@sweatpants/durable-execution";
import { assertJson, stableTupleHash, type Json } from "@sweatpants/foundation";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import type { CommandReceipt, ConversationHead } from "@sweatpants/history-store/contract";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import { useModel, useStreamOptions } from "@sweatpants/model-provider";
import { ToolRuntimeApi, ToolRuntimePort } from "@sweatpants/tool-runtime";
import type { Operation } from "effection";
import { conversationAuthorityFrame } from "../conversation-authority.ts";
import {
  acceptedPublicMessageFact,
  buildConversationWindow,
  ConversationCheckpointConflictError,
  persistConversationCheckpoint,
  preflightConversationCheckpoint,
} from "../conversation-persistence.ts";
import {
  beginTurnPublication,
  recoverTerminalPublication,
  type BeginTurnPublicationRequest,
} from "../index.ts";
import { settleInterruptForThread } from "../interrupts/index.ts";
import { useLogger } from "../logger/index.ts";
import { useOptionalProgramDriverEphemeralEffects } from "../program-driver/effects.ts";
import { useOptionalProgramDriverNativeTools } from "../program-driver/native-tools.ts";
import {
  createSerializedEventStream,
  useSessionRegistry,
  type ChatEngineSource,
  type SessionHandle,
  type SessionRegistry,
  type TurnEventSink,
} from "../response-streams/index.ts";
import type { SetupResult } from "../streaming.ts";
import type { ChatExecutionContext } from "./chat-execution-context.ts";
import type { ChatRequestContext } from "./chat-stream-endpoint.ts";
import { prepareChatTools } from "./chat-tools.ts";
import {
  authoritativeCommandSnapshot,
  type AuthoritativeCommandSnapshot,
} from "./command-history.ts";
import {
  createConversationCommandErrorResponse,
  createStoredConversationCheckpointResponse,
} from "./hydrate-responses.ts";
import { preparedModelContextByteLimit } from "./model-sampling/service.ts";
import { manifest as chatProgramManifest } from "./program-driver-schema.ts";
import { createProgramDriverChatEngine } from "./program-driver/program-driver-chat-engine.ts";
import { reconnectResponse } from "./reconnect-response.ts";
import { directChatSubscription, nextResponseWriterFence } from "./response-subscription.ts";
import { planTurn } from "./turn-plan.ts";
import { createTurnPublishers } from "./turn-publication.ts";
import {
  claimDetachedTurnRecovery,
  createLiveCancellationEngine,
  createLiveProgramActivation,
  recoveredPublicationEvents,
} from "./turn-recovery.ts";
import type { WorkflowChatEngineParams } from "./types.ts";

/** Runs an admitted command or reconnects/reclaims an active Turn. HTTP endpoint policy is already resolved. */
export function* executeChatTurn(
  execution: ChatExecutionContext,
  context: ChatRequestContext,
  resolvedHead: ConversationHead | null,
  selectedCommandReceipt: CommandReceipt | null,
): Operation<SetupResult> {
  const { config, storage, projectionTokens, programDriverJournalStore, liveProgramActivations } =
    execution;
  const {
    body,
    request,
    ctx,
    selectedHead,
    stores,
    conversationId: requestedConversationId,
  } = context;
  const selectedActiveExecutionId = selectedHead?.activeExecutionId;
  const { maxToolIterations = 10 } = config;
  const checkpointTargets = storage.profile === "low" ? LOW_CHECKPOINT_TARGETS : undefined;
  const activeResponseTailId =
    resolvedHead?.activeCommand &&
    typeof resolvedHead.activeCommand === "object" &&
    !Array.isArray(resolvedHead.activeCommand) &&
    typeof resolvedHead.activeCommand["commandId"] === "string"
      ? resolvedHead.activeCommand["commandId"]
      : resolvedHead?.activeExecutionId;
  const sessionId = stableTupleHash([
    "chat-response-tail",
    requestedConversationId,
    body.command?.commandId ?? activeResponseTailId ?? resolvedHead?.revision ?? "hydrate",
  ]);
  const isReconnect =
    !body.command && (resolvedHead?.state === "running" || resolvedHead?.state === "recovering");

  ctx.headers.set("Cache-Control", "private, no-store");

  // Get logger after hooks run (so setupLogger has executed)
  const log = yield* useLogger("handler:durable");
  log.debug(
    {
      sessionId,
      conversationId: requestedConversationId,

      isReconnect,
      messageCount: body.messages.length,
    },
    "request received",
  );

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
  const agUiRunId = body.runId?.trim() || crypto.randomUUID();

  // The tool runtime seam is optional, so presence is probed here.
  const toolRuntimeInstalled = yield* ToolRuntimePort.isInstalled();
  const activeToolRuntime = toolRuntimeInstalled ? ToolRuntimeApi.operations : undefined;
  // F5: resolve the optional history policy in request scope; the engine
  // runs in a background writer task without these contexts.
  const historyPolicy = yield* HistoryPolicyContext.get();
  // Resume validation is pure. Interrupt state is committed only after the
  // crank respond commands are durably accepted by the adapter.
  const participantId = config.resolveParticipantId
    ? (yield* config.resolveParticipantId(request)).trim()
    : "anonymous";
  if (!participantId || participantId.length > 512) {
    throw new CrankError(
      "invalid_participant",
      "Trusted participant identity must be a bounded non-empty string",
    );
  }
  const plan = planTurn(body);
  if (
    body.command?.type === "respond-to-elicit" &&
    selectedCommandReceipt !== null &&
    selectedCommandReceipt.commandDigest !== stableTupleHash([body.command, null])
  ) {
    return yield* createConversationCommandErrorResponse({
      conversationId: requestedConversationId,
      code: "command_identity_conflict",
      message: `Command ${body.command.commandId} has conflicting identity`,
    });
  }
  if (body.command?.type === "respond-to-elicit" && selectedCommandReceipt === null) {
    if (
      selectedHead?.state !== "parked" ||
      selectedHead.activeLogicalTurnId !== body.command.logicalTurnId ||
      selectedHead.activeExecutionId !== body.command.executionId
    ) {
      return yield* createConversationCommandErrorResponse({
        conversationId: requestedConversationId,
        code: "elicit_not_open",
        message: `Conversation ${requestedConversationId} is not parked on that elicitation Turn`,
      });
    }
    const response = plan.effectiveElicitResponses[0];
    if (!response || response.elicitId !== body.command.interruptId) {
      return yield* createConversationCommandErrorResponse({
        conversationId: requestedConversationId,
        code: "elicit_response_invalid",
        message: "Elicitation response does not identify the selected interrupt",
      });
    }
    const journal = yield* programDriverJournalStore.open(requestedConversationId);
    const validation = yield* journal.validateElicitResponse({
      sessionId: requestedConversationId,
      pullId: body.command.interruptId,
      participantId,
      completion: assertJson(response.completion),
    });
    if (validation.status !== "valid") {
      const code =
        validation.status === "audience_invalid"
          ? "elicit_audience_forbidden"
          : validation.status === "not_pending" || validation.status === "expired"
            ? "elicit_not_open"
            : "elicit_response_invalid";
      return yield* createConversationCommandErrorResponse({
        conversationId: requestedConversationId,
        code,
        message: `Elicitation response preflight failed: ${validation.status}`,
      });
    }
  }
  let authoritativeSnapshot: AuthoritativeCommandSnapshot;
  try {
    authoritativeSnapshot = yield* authoritativeCommandSnapshot({
      conversationId: requestedConversationId,
      head: selectedHead,
      command: body.command,
      submitted: body.messages,
      maxModelContextBytes: preparedModelContextByteLimit(model.contextWindow),
    });
  } catch (error) {
    if (error instanceof CrankError) {
      return yield* createConversationCommandErrorResponse({
        conversationId: requestedConversationId,
        code: error.code,
        message: error.message,
      });
    }
    throw error;
  }
  const authoritativeMessages = authoritativeSnapshot.messages;
  const controlHead =
    body.command?.type === "interrupt-turn"
      ? yield* stores.conversation.loadHead(requestedConversationId)
      : selectedHead;
  if (
    body.command?.type === "interrupt-turn" &&
    (controlHead?.activeLogicalTurnId !== body.command.logicalTurnId ||
      controlHead.activeExecutionId !== body.command.executionId)
  ) {
    return yield* createConversationCommandErrorResponse({
      conversationId: requestedConversationId,
      code: "active_turn_changed",
      message: `Conversation ${requestedConversationId} active Turn changed`,
    });
  }
  const controlActiveExecutionId = controlHead?.activeExecutionId;
  const selectedLiveActivation = liveProgramActivations.get(requestedConversationId);
  const cancelReason = plan.effectivePluginAbort?.reason ?? "Program was cancelled";
  const hostCancelParkedOrOrphaned =
    Boolean(plan.effectivePluginAbort) &&
    Boolean(controlActiveExecutionId) &&
    (controlHead?.state !== "running" ||
      selectedLiveActivation?.executionId !== controlActiveExecutionId);
  const liveCancellation =
    plan.effectivePluginAbort &&
    !hostCancelParkedOrOrphaned &&
    controlHead?.state === "running" &&
    controlActiveExecutionId &&
    selectedLiveActivation?.executionId === controlActiveExecutionId
      ? {
          activation: selectedLiveActivation,
          reason: cancelReason,
        }
      : null;

  log.debug(
    { provider: model.provider, model: model.id, api: model.api },
    "model provider configured",
  );

  const { inventoryEntries, toolSchemas, systemPrompt, maxIterations } = yield* prepareChatTools(
    body,
    sessionId,
    requestedConversationId,
    maxToolIterations,
  );
  // Get session registry from durable streams context
  log.debug("getting session registry");
  const registry: SessionRegistry<StreamEvent> = yield* useSessionRegistry<StreamEvent>();
  log.debug("session registry acquired");

  let session: SessionHandle<StreamEvent> | undefined;
  let recoverDetachedSession = false;
  let responsePrefix: readonly StreamEvent[] = [];
  let responseStartLSN = 0;

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

  if (isReconnect) {
    ({ session, recoverDetachedSession, responsePrefix, responseStartLSN } =
      yield* reconnectResponse(
        execution,
        context,
        registry,
        sessionId,
        toolSchemas,
        selectedLiveActivation,
      ));
  }

  if (!isReconnect || recoverDetachedSession) {
    // NEW OR RECOVERY SESSION PATH: construct the source, but the
    // registry turns it only after claiming an absent/detached writer.
    log.debug({ sessionId }, "new session path: creating chat engine");

    const agUiRun = {
      threadId: agUiThreadId,
      runId: agUiRunId,
      ...(body.parentRunId ? { parentRunId: body.parentRunId } : {}),
    };
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
    const sendCommand = body.command?.type === "send-message" ? body.command : null;
    const acceptedCommandMessage = sendCommand
      ? (authoritativeMessages.find((entry) => entry.id === sendCommand.messageId) ?? null)
      : null;
    const runStartedEvent: StreamEvent = {
      type: EventType.RUN_STARTED,
      ...agUiRun,
      input: {
        ...agUiRun,
        state: body.state ?? {},
        messages: [],
        tools: toolSchemas.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
        context: body.context ?? [],
        forwardedProps: body.forwardedProps ?? {},
        ...(body.resume ? { resume: body.resume } : {}),
      },
    };
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
        body.command?.commandId ??
        body.runId?.trim() ??
        stableTupleHash([body.command?.type ?? "recover", agUiRunId]),
      commandDigest: stableTupleHash([body.command ?? null, acceptedCommandMessage]),
      participantId,
      acceptedAt: Date.now(),
      retainUntil: body.command?.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1_000,
      expectedRevision: body.command?.basisRevision ?? resolvedHead?.revision ?? null,
      admission:
        body.command?.type === "respond-to-elicit"
          ? ("respond-to-elicit" as const)
          : ("send-message" as const),
      preflight: function* (): Operation<void> {
        yield* preflightConversationCheckpoint({
          conversationId: requestedConversationId,
          roots: [
            ...toProviderHistorySnapshot(body.messages).map(acceptedPublicMessageFact),
            assertJson(runStartedEvent),
          ],
          logicalTurnId: selectedHead?.activeLogicalTurnId ?? agUiRunId,
          executionId:
            selectedHead?.activeExecutionId ?? `chat-turn:${requestedConversationId}:${agUiRunId}`,
          ...(checkpointTargets ? { targets: checkpointTargets } : {}),
          expectedRevision: body.command?.basisRevision ?? selectedHead?.revision ?? null,
          ...(selectedHead?.ownerEpoch ? { expectedOwnerEpoch: selectedHead.ownerEpoch } : {}),
          expectedExecutionId: selectedHead?.activeExecutionId ?? null,
        });
      },
      ...(body.command?.type === "respond-to-elicit"
        ? {
            expectedLogicalTurnId: body.command.logicalTurnId,
            expectedExecutionId: body.command.executionId,
          }
        : {}),
    };
    let authorityTurn: BeginTurnPublicationRequest | undefined;
    if (
      body.command &&
      body.command.type !== "interrupt-turn" &&
      !recoveredPublication &&
      !liveCancellation &&
      !hostCancelParkedOrOrphaned
    ) {
      try {
        authorityTurn = yield* beginTurnPublication(proposedAuthorityTurn);
        if (authorityTurn.idempotent) {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code: "command_in_progress",
            message: `Command ${authorityTurn.commandId} is already active`,
          });
        }
      } catch (error) {
        if (error instanceof CrankError && error.code === "command_already_terminal") {
          const retryHead = yield* stores.conversation.loadHead(requestedConversationId);
          const retryCheckpoint = retryHead?.checkpoint
            ? yield* stores.conversation.getCheckpoint(retryHead.checkpoint)
            : null;
          if (retryCheckpoint && retryHead) {
            const retryWindow = yield* buildConversationWindow({
              conversationId: requestedConversationId,
              head: retryHead,
              checkpoint: retryCheckpoint,
              keyring: projectionTokens,
              ...(body.knownWindowToken ? { knownWindowToken: body.knownWindowToken } : {}),
              ...(config.projectionTokenTtlMs === undefined
                ? {}
                : { tokenTtlMs: config.projectionTokenTtlMs }),
            });
            return yield* createStoredConversationCheckpointResponse({
              conversationId: requestedConversationId,
              head: retryHead,
              window: retryWindow,
            });
          }
        }
        if (
          error instanceof ConversationCheckpointConflictError ||
          (error instanceof CrankError &&
            (error.code === "conversation_state_changed" ||
              error.code === "conversation_not_idle" ||
              error.code === "active_turn_changed" ||
              error.code === "command_identity_conflict" ||
              error.code === "command_already_terminal" ||
              error.code === "checkpoint_bound_exceeded"))
        ) {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code:
              error instanceof ConversationCheckpointConflictError
                ? "conversation_state_changed"
                : error.code,
            message: error.message,
          });
        }
        throw error;
      }
    }
    if (
      !body.command &&
      !authorityTurn &&
      !recoveredPublication &&
      resolvedHead?.activeExecutionId
    ) {
      if (
        recoverDetachedSession &&
        resolvedHead.activeLogicalTurnId &&
        resolvedHead.activeExecutionId
      ) {
        yield* claimDetachedTurnRecovery({
          conversationId: requestedConversationId,
          commandId: stableTupleHash([
            "recover-writer",
            sessionId,
            resolvedHead.revision,
            resolvedHead.activeExecutionId,
          ]),
          kind: "recover-writer",
          logicalTurnId: resolvedHead.activeLogicalTurnId,
          executionId: resolvedHead.activeExecutionId,
        });
      }
      const activeRecord = yield* TurnJournalAuthority.operations.read(
        resolvedHead.activeExecutionId,
      );
      if (activeRecord && activeRecord.format !== "sweatpants.terminal-execution.v1") {
        authorityTurn = {
          ...proposedAuthorityTurn,
          executionId: activeRecord.executionId,
          sessionId: activeRecord.sessionId,
          turnId: activeRecord.turnId,
          rootTaskId: activeRecord.rootTaskId,
          rootProgram: activeRecord.rootProgram,
        };
      }
    }
    if (hostCancelParkedOrOrphaned) {
      const interruptCommand = body.command;
      if (!interruptCommand || interruptCommand.type !== "interrupt-turn") {
        throw new CrankError(
          "invalid_chat_request",
          "Detached cancellation requires an interrupt-turn command",
        );
      }
      try {
        yield* claimDetachedTurnRecovery({
          conversationId: requestedConversationId,
          commandId: interruptCommand.commandId,
          kind: "interrupt-turn",
          logicalTurnId: interruptCommand.logicalTurnId,
          executionId: interruptCommand.executionId,
        });
      } catch (error) {
        if (error instanceof CrankError) {
          return yield* createConversationCommandErrorResponse({
            conversationId: requestedConversationId,
            code: error.code,
            message: error.message,
          });
        }
        throw error;
      }
      const activeRecord = yield* TurnJournalAuthority.operations.read(
        interruptCommand.executionId,
      );
      if (!activeRecord || activeRecord.format === "sweatpants.terminal-execution.v1") {
        return yield* createConversationCommandErrorResponse({
          conversationId: requestedConversationId,
          code: "active_turn_changed",
          message: `Conversation ${requestedConversationId} has no recoverable active Turn`,
        });
      }
      authorityTurn = {
        ...proposedAuthorityTurn,
        executionId: activeRecord.executionId,
        sessionId: activeRecord.sessionId,
        turnId: activeRecord.turnId,
        rootTaskId: activeRecord.rootTaskId,
        rootProgram: activeRecord.rootProgram,
      };
    }
    const liveActivation = authorityTurn
      ? createLiveProgramActivation(authorityTurn.executionId)
      : null;
    if (liveActivation) {
      liveProgramActivations.set(requestedConversationId, liveActivation);
    }
    const programDriverEphemeralEffects = yield* useOptionalProgramDriverEphemeralEffects();
    const programDriverNativeTools = yield* useOptionalProgramDriverNativeTools();

    // Create the chat engine. If public resume validation failed, use an
    // empty engine and expose the failure as a schema-valid RUN_ERROR before
    // any replay projection or runtime continuation can occur.
    const respondCommand = body.command?.type === "respond-to-elicit" ? body.command : null;
    if (
      authorityTurn &&
      authorityTurn.executionId === proposedAuthorityTurn.executionId &&
      !recoveredPublication
    ) {
      const runningHead = yield* stores.conversation.loadHead(requestedConversationId);
      if (runningHead) {
        const admissionFacts: Json[] = [
          ...toProviderHistorySnapshot(body.messages).map(acceptedPublicMessageFact),
          assertJson(runStartedEvent),
        ];
        yield* persistConversationCheckpoint({
          conversationId: requestedConversationId,
          causeKey: stableTupleHash([authorityTurn.executionId, "nonterminal", admissionFacts]),
          cause: {
            kind: "tail-cut",
            cutKind: "rolling",
            executionId: authorityTurn.executionId,
            logicalTurnId: authorityTurn.turnId,
          },
          roots: admissionFacts,
          ...(checkpointTargets ? { targets: checkpointTargets } : {}),
          expectedRevision: runningHead.revision,
          expectedOwnerEpoch: runningHead.ownerEpoch,
          expectedExecutionId: authorityTurn.executionId,
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
    const contextHead = authorityTurn
      ? yield* stores.conversation.loadHead(requestedConversationId)
      : resolvedHead;
    const sourceCheckpoint = contextHead?.checkpoint;
    const activeCommandId =
      contextHead?.activeCommand &&
      typeof contextHead.activeCommand === "object" &&
      !Array.isArray(contextHead.activeCommand) &&
      typeof contextHead.activeCommand["commandId"] === "string"
        ? contextHead.activeCommand["commandId"]
        : authorityTurn?.commandId;
    const engineParams: WorkflowChatEngineParams = {
      messages: authoritativeMessages,
      ...(sourceCheckpoint && authorityTurn && activeCommandId
        ? {
            modelContextSource: {
              type: "conversation" as const,
              conversationId: requestedConversationId,
              checkpoint: { checkpointId: sourceCheckpoint.checkpointId },
              acceptedCommandId: activeCommandId,
              executionId: authorityTurn.executionId,
              taskId: authorityTurn.rootTaskId,
              taskJournalFrontier: "current",
              ...(systemPrompt !== undefined ? { systemPrompt } : {}),
            },
          }
        : {}),
      ...(systemPrompt !== undefined && { systemPrompt }),
      toolSchemas,
      model,
      ...(streamOptions ? { streamOptions } : {}),
      ...(plan.initialToolChoice ? { initialToolChoice: plan.initialToolChoice } : {}),
      toolInventoryEntries: inventoryEntries,
      ...(activeToolRuntime ? { toolRuntime: activeToolRuntime } : {}),
      ...(historyPolicy ? { historyPolicy } : {}),
      maxIterations,
      conversationId: requestedConversationId,
      conversationStore: stores.conversation,
      participantId,
      agUiRun,
      onLiveTaskReady(taskId): void {
        liveActivation?.taskReady.resolve(taskId);
      },
      onLiveActivationSettled(error): void {
        const failure = error ?? new Error("Live activation settled before terminal publication");
        liveActivation?.taskReady.reject(failure);
        liveActivation?.terminal.reject(failure);
        if (liveProgramActivations.get(requestedConversationId) === liveActivation) {
          liveProgramActivations.delete(requestedConversationId);
        }
      },
      ...(resolvedHead !== null ? { recoveryOnly: true } : {}),
      ...(plan.effectiveElicitResponses.length > 0 && {
        elicitResponses: plan.effectiveElicitResponses,
      }),
      ...(respondCommand
        ? {
            onResumeAccepted: function* (): Operation<void> {
              settleInterruptForThread(
                agUiThreadId,
                respondCommand.interruptId,
                respondCommand.status,
              );
            },
          }
        : {}),
      ...(plan.effectivePluginAbort && { pluginAbort: plan.effectivePluginAbort }),
      ...createTurnPublishers(execution, context, authorityTurn, liveActivation),
    };
    const engineSource: ChatEngineSource = liveCancellation
      ? createLiveCancellationEngine({
          journalStore: programDriverJournalStore,
          activation: liveCancellation.activation,
          conversationId: requestedConversationId,
          reason: liveCancellation.reason ?? "Program was cancelled",
          commandId: body.command?.commandId ?? agUiRunId,
        })
      : recoveredPublication
        ? recoveredPublicationEvents(recoveredPublication)
        : (liveEvent: TurnEventSink) =>
            createProgramDriverChatEngine({
              ...engineParams,
              journalStore: programDriverJournalStore,
              liveEvent,
              ...(programDriverEphemeralEffects
                ? { ephemeralEffects: programDriverEphemeralEffects }
                : {}),
              ...(programDriverNativeTools ? { nativeTools: programDriverNativeTools } : {}),
            });
    log.debug({ sessionId }, "new session path: chat engine created");

    // An admitted native segment starts with RUN_STARTED. The
    // complete bounded ConversationWindow and running authority
    // atomically establish its public base before incrementals.
    const initialEvents: StreamEvent[] = [runStartedEvent];

    const authorityHead = yield* stores.conversation.loadHead(requestedConversationId);
    if (!authorityHead) {
      throw new Error(`Conversation ${requestedConversationId} has no admitted head`);
    }
    const authorityCheckpoint = authorityHead.checkpoint
      ? yield* stores.conversation.getCheckpoint(authorityHead.checkpoint)
      : null;
    if (!authorityCheckpoint) {
      throw new Error(`Conversation ${requestedConversationId} running checkpoint is missing`);
    }
    initialEvents.push(
      yield* buildConversationWindow({
        conversationId: requestedConversationId,
        head: authorityHead,
        checkpoint: authorityCheckpoint,
        keyring: projectionTokens,
        ...(body.knownWindowToken ? { knownWindowToken: body.knownWindowToken } : {}),
        ...(config.projectionTokenTtlMs === undefined
          ? {}
          : { tokenTtlMs: config.projectionTokenTtlMs }),
      }),
    );
    initialEvents.push(conversationAuthorityFrame(requestedConversationId, authorityHead));

    // Acquire the one Host-owned response buffer before constructing the
    // pull source. workflow host is turned only when this sole writer asks
    // the engine for its next event; live model activity appends directly
    // to the same reconnectable buffer from inside that crank turn.
    log.debug({ sessionId }, "new session path: acquiring session with source");
    session = yield* registry.acquire(sessionId, {
      writer: nextResponseWriterFence(sessionId),
      recoverIfDetached: resolvedHead !== null,
      source: (_responseTokenBuffer, responseTokenWriter) =>
        createSerializedEventStream(engineSource, initialEvents, {
          responseTokenBuffer: responseTokenWriter,
        }),
    });
    log.debug({ sessionId }, "new session path: session acquired");
  }

  if (!session) {
    throw new Error(`Conversation response session ${sessionId} was not acquired`);
  }

  const response = yield* directChatSubscription(
    registry,
    session,
    responsePrefix,
    responseStartLSN,
  );
  return { subscription: response };
}
