/**
 * Durable Chat Handler
 *
 * Finite native Chat response segments backed by a server-internal response
 * tail. Public requests and responses never expose response sessions, LSNs,
 * offsets, cursors, or Durable Streams delivery headers.
 *
 * Identity law:
 * - conversationId: the only durable public conversation key
 * - threadId: AG-UI alias of conversationId
 * - runId: finite response-segment correlator
 * - response-tail identity and position: server-internal only
 *
 * This module composes strict native request normalization, durable command
 * admission, bounded ConversationWindow publication, internal response-tail
 * delivery, and typed checkpoint/history authority.
 */
import { EventType } from "@ag-ui/core";
import {
  call,
  ensure,
  resource,
  withResolvers,
  type Operation,
  type Scope,
  type Stream,
  type Subscription,
  type WithResolvers,
} from "effection";
import { CrankError } from "@sweatpants/durable-execution";
import {
  useSessionRegistry,
  createDurableTurnOwner,
  type DurableTurnOwner,
  type SessionHandle,
  type SessionRegistry,
} from "../response-streams/index.ts";
import { MaxIterationsContext, PersonaResolverContext } from "../contexts.ts";
import {
  agUiMessagesToChatHistoryEntries,
  ConversationSegmentValidator,
  createChatTurnCompletedFact,
  decodePublicProjectionRoot,
  projectChatTurnFacts,
  toProviderHistorySnapshot,
  type PublicProjectionRoot,
  type ChatHistoryEntry,
  type ConversationCommand,
} from "@sweatpants/chat-core";
import { useModel, useStreamOptions } from "@sweatpants/model-provider";
import { ToolInventoryApi, ToolRuntimeApi, ToolRuntimePort } from "@sweatpants/tool-runtime";
import type { ChatToolDefinition } from "@sweatpants/chat-contract";
import { ToolExposureApi } from "@sweatpants/chat-core";
import { HistoryPolicyContext } from "@sweatpants/chat-core";
import { useLogger } from "../logger/index.ts";
import { bindModel, createBindingSource, stringParam } from "./model-binder.ts";
import { createStreamingEndpoint, HandlerContext, type ScopedEndpoint } from "../streaming.ts";
import type { ConversationStreamEvent as StreamEvent } from "@sweatpants/chat-core";
import { createProgramDriverChatEngine } from "./program-driver/program-driver-chat-engine.ts";
import { manifest as chatProgramManifest } from "./program-driver-schema.ts";
import { preparedModelContextByteLimit } from "./model-sampling/service.ts";
import { useOptionalProgramDriverEphemeralEffects } from "../program-driver/effects.ts";
import { useOptionalProgramDriverNativeTools } from "../program-driver/native-tools.ts";
import {
  createSerializedEventStream,
  type ChatEngineSource,
  type TurnEventSink,
} from "../response-streams/index.ts";
import type {
  ChatRequestBody,
  DurableChatEndpoints,
  DurableChatHandlerConfig,
  DurableChatReadRequest,
  DurableChatStorageInspection,
  WorkflowChatEngineParams,
  ToolSchema,
} from "./types.ts";
import {
  resolveDurableChatComposition,
  type ResolvedDurableChatComposition,
} from "./configuration.ts";
import { cancelOpenInterruptsForThread, settleInterruptForThread } from "../interrupts/index.ts";
import { parseChatRequestBody } from "./request-normalization.ts";
import { planTurn } from "./turn-plan.ts";
import { createEmptyStream, createPullStream } from "@sweatpants/durable-streams";
import {
  createConversationCommandErrorResponse,
  createStoredConversationCheckpointResponse,
} from "./hydrate-responses.ts";
import { useHostScopeOwner } from "../host/host-scope.ts";
import { useExecutionStore } from "@sweatpants/journal-authority/api";
import { ConversationStoreApi, useConversationStore } from "@sweatpants/history-store/port";
import {
  beginTurnPublication,
  completeAndPublishTurn,
  recoverTerminalPublication,
  type BeginTurnPublicationRequest,
  type RecoveredTurnPublication,
} from "../index.ts";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import {
  acceptedPublicMessageFact,
  buildConversationWindow,
  ConversationCheckpointConflictError,
  persistConversationCheckpoint,
  preflightConversationCheckpoint,
  readAllPublicRootsForModel,
} from "../conversation-persistence.ts";
import { LOW_CHECKPOINT_TARGETS } from "@sweatpants/history-store";
import { assertJson, stableTupleHash, type Json } from "@sweatpants/foundation";
import type { ConversationHead } from "@sweatpants/history-store/contract";
import { conversationAuthority, conversationAuthorityFrame } from "../conversation-authority.ts";
import { createDurableHistoryPageEndpoint } from "./history-page-endpoint.ts";
import type { ProgramDriverJournalStore } from "./program-driver-journal.ts";
import {
  assertChatSqliteStorageVariant,
  chatStorageForScope,
  installChatStorageDrivers,
  resolveImmediateChatStorage,
  type ChatStorageConfig,
  type ResolvedChatStorage,
} from "./storage.ts";

/** Storage kinds that open one handle per application scope. */
function isScopedChatStorage(
  config: ChatStorageConfig,
): config is Extract<ChatStorageConfig, { readonly kind: "sqlite" | "postgres" }> {
  return config.kind === "sqlite" || config.kind === "postgres";
}

const MAX_CHAT_REQUEST_BYTES = 2 * 1024 * 1024;
let responseWriterEpoch = 1;

function* directChatSubscription(
  registry: SessionRegistry<StreamEvent>,
  session: SessionHandle<StreamEvent>,
  prefix: readonly StreamEvent[] = [],
  startLSN = 0,
): Operation<Subscription<string, void>> {
  const validator = new ConversationSegmentValidator();
  let prefixIndex = 0;
  let finished = false;
  const stream: Stream<string, void> = resource(function* (provide) {
    // The response subscription owns the registry reference. This is the
    // stream-scoped equivalent of Cordis Fiber.effect(): acquire happens
    // before this resource is returned, and release is guaranteed when the
    // response scope is destroyed, including client cancellation and setup
    // failure after acquisition.
    yield* ensure(() => registry.release(session.id));
    const subscription = yield* createPullStream(session.buffer, startLSN);
    yield* provide({
      *next(): Operation<IteratorResult<string, void>> {
        const next =
          prefixIndex < prefix.length
            ? { done: false as const, value: { token: prefix[prefixIndex++]!, lsn: 0 } }
            : yield* subscription.next();
        if (next.done) {
          if (!finished) validator.finish();
          return { done: true, value: undefined };
        }
        const event = next.value.token;
        validator.push(event);
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
          validator.finish();
          finished = true;
        }
        return { done: false, value: JSON.stringify(event) };
      },
    });
  });
  return yield* stream;
}

function* claimDetachedTurnRecovery(
  request: {
    conversationId: string;
    commandId: string;
    kind: "interrupt-turn" | "recover-writer";
    logicalTurnId: string;
    executionId: string;
  },
): Operation<ConversationHead> {
  const store = yield* useConversationStore();
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const head = yield* store.loadHead(request.conversationId);
    if (
      !head ||
      head.activeLogicalTurnId !== request.logicalTurnId ||
      head.activeExecutionId !== request.executionId
    ) {
      throw new CrankError(
        "active_turn_changed",
        `Conversation ${request.conversationId} active Turn changed`,
      );
    }
    if (head.state === "idle" || head.state === "deleted") {
      throw new CrankError(
        "active_turn_changed",
        `Conversation ${request.conversationId} has no recoverable active Turn`,
      );
    }
    const activeCommand =
      head.activeCommand &&
      typeof head.activeCommand === "object" &&
      !Array.isArray(head.activeCommand)
        ? head.activeCommand
        : null;
    if (
      head.state === "running" &&
      activeCommand?.["kind"] === request.kind &&
      activeCommand["commandId"] === request.commandId
    ) {
      return head;
    }
    const claimed = yield* store.compareAndSwapHead(
      request.conversationId,
      head.revision,
      head.ownerEpoch,
      {
        state: "running",
        checkpoint: head.checkpoint,
        terminalHistory: head.terminalHistory,
        activeLogicalTurnId: head.activeLogicalTurnId,
        activeExecutionId: head.activeExecutionId,
        latestCompletedExecutionId: head.latestCompletedExecutionId,
        activeSegment: null,
        activeCommand: {
          kind: request.kind,
          commandId: request.commandId,
          logicalTurnId: request.logicalTurnId,
          executionId: request.executionId,
        },
        deletedAt: null,
        ownerTransition: {
          kind: "assign",
          ownerRoute: {
            kind: request.kind,
            commandId: request.commandId,
            executionId: request.executionId,
          },
        },
      },
    );
    if (claimed.status === "committed") {
      return claimed.head;
    }
  }
  throw new CrankError(
    "conversation_state_changed",
    `Conversation ${request.conversationId} recovery claim did not converge`,
  );
}

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
  conversationId: stringParam("x-conversation-id", "conversationId"),
});

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function historyEntriesFromRoots(roots: readonly Json[]): readonly ChatHistoryEntry[] {
  const messages = roots
    .map((root) => decodePublicProjectionRoot(root))
    .filter(
      (root): root is Extract<PublicProjectionRoot, { kind: "message" }> => root.kind === "message",
    )
    .sort((left, right) => {
      const a = BigInt(left.position);
      const b = BigInt(right.position);
      return a === b ? 0 : a < b ? -1 : 1;
    })
    .map((root) => root.message);
  return agUiMessagesToChatHistoryEntries(messages);
}

interface AuthoritativeCommandSnapshot {
  readonly messages: readonly ChatHistoryEntry[];
  readonly activities: readonly StreamEvent[];
}

function* authoritativeCommandSnapshot(params: {
  conversationId: string;
  head: ConversationHead | null;
  command: ConversationCommand | undefined;
  submitted: readonly ChatHistoryEntry[];
  maxModelContextBytes: number;
}): Operation<AuthoritativeCommandSnapshot> {
  const store = yield* useConversationStore();
  let base: readonly ChatHistoryEntry[] = [];
  let activities: readonly StreamEvent[] = [];
  if (params.head?.checkpoint) {
    const checkpoint = yield* store.getCheckpoint(params.head.checkpoint);
    if (!checkpoint) {
      throw new CrankError(
        "conversation_checkpoint_missing",
        `Conversation ${params.conversationId} checkpoint is missing`,
      );
    }
    base = historyEntriesFromRoots(
      yield* readAllPublicRootsForModel(
        params.conversationId,
        checkpoint,
        params.maxModelContextBytes,
      ),
    );
    activities = [];
  }

  const snapshot = (messages: readonly ChatHistoryEntry[]): AuthoritativeCommandSnapshot => ({
    messages,
    activities,
  });
  const command = params.command;
  if (!command || command.type === "interrupt-turn" || command.type === "respond-to-elicit") {
    return snapshot(base);
  }
  if (command.type === "send-message") {
    const accepted = params.submitted.filter(
      (entry) =>
        entry.type === "message" && entry.id === command.messageId && entry.message.role === "user",
    );
    if (accepted.length !== 1) {
      throw new CrankError(
        "invalid_chat_request",
        `send-message must carry exactly one matching user message ${command.messageId}`,
      );
    }
    const existing = base.find((entry) => entry.id === accepted[0]!.id);
    if (existing) {
      if (stableTupleHash([existing]) !== stableTupleHash([accepted[0]!])) {
        throw new CrankError(
          "command_identity_conflict",
          `Message ${accepted[0]!.id} conflicts with authoritative history`,
        );
      }
      return snapshot(base);
    }
    return snapshot([...base, accepted[0]!]);
  }

  const targetId = command.targetMessageId;
  if (!targetId) {
    let lastAssistant = -1;
    for (let index = base.length - 1; index >= 0; index -= 1) {
      const entry = base[index]!;
      if (entry.type === "message" && entry.message.role === "assistant") {
        lastAssistant = index;
        break;
      }
    }
    return snapshot(lastAssistant < 0 ? base : base.slice(0, lastAssistant));
  }
  const targetIndex = base.findIndex((entry) => entry.id === targetId);
  if (targetIndex < 0 || base[targetIndex]?.type !== "message") {
    throw new CrankError("invalid_chat_request", `Regenerate target ${targetId} does not exist`);
  }
  const target = base[targetIndex];
  return snapshot(
    target.message.role === "user" ? base.slice(0, targetIndex + 1) : base.slice(0, targetIndex),
  );
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
  journalStore: ProgramDriverJournalStore;
  activation: LiveProgramActivation;
  conversationId: string;
  reason: string;
  commandId: string;
}): ChatEngineSource {
  return resource(function* (provide) {
    let events: StreamEvent[] | null = null;
    let index = 0;
    const store = yield* useConversationStore();
    yield* provide({
      *next(): Operation<IteratorResult<StreamEvent, void>> {
        if (events === null) {
          const taskId = yield* params.activation.taskReady.operation;
          const journal = yield* params.journalStore.open(params.conversationId);
          yield* journal.requestCancellation(
            params.conversationId,
            taskId,
            params.reason,
            params.commandId,
          );
          // The original Host-owned activation performs unwind and terminal
          // publication. Publish its resulting authority before this control
          // response emits its terminal presentation event.
          yield* params.activation.terminal.operation;
          const head = yield* store.loadHead(params.conversationId);
          events = [
            conversationAuthorityFrame(params.conversationId, head),
            {
              type: EventType.RUN_ERROR,
              code: "PROGRAM_CANCELLED",
              message: params.reason,
            },
          ];
        }
        if (index >= events.length) return { done: true, value: undefined };
        return { done: false, value: events[index++]! };
      },
    });
  });
}

// =============================================================================
// DURABLE CHAT ENDPOINTS
// =============================================================================

type ChatStreamInvocation =
  | { readonly kind: "post-chat"; readonly request: Request }
  | ({ readonly kind: "read-chat" } & DurableChatReadRequest);

function mapScopedEndpoint<Source, Target>(
  endpoint: ScopedEndpoint<Target>,
  map: (source: Source) => Target,
): ScopedEndpoint<Source> {
  const mapped = (source: Source): Promise<Response> => endpoint(map(source));
  mapped.withScope = (scope: Scope) => {
    const scoped = endpoint.withScope(scope);
    return (source: Source): Promise<Response> => scoped(map(source));
  };
  return mapped;
}

type DurableChatEndpointSet = Pick<DurableChatEndpoints, "postChat" | "readChat" | "pageHistory">;

interface ResolvedEndpointBundle {
  readonly endpoints: DurableChatEndpointSet;
  readonly inspection: DurableChatStorageInspection;
}

function bindEndpointSet(endpoints: DurableChatEndpointSet, scope: Scope): DurableChatEndpointSet {
  return {
    postChat: Object.assign(endpoints.postChat.withScope(scope), {
      withScope: (nextScope: Scope) => endpoints.postChat.withScope(nextScope),
    }),
    readChat: Object.assign(endpoints.readChat.withScope(scope), {
      withScope: (nextScope: Scope) => endpoints.readChat.withScope(nextScope),
    }),
    pageHistory: Object.assign(endpoints.pageHistory.withScope(scope), {
      withScope: (nextScope: Scope) => endpoints.pageHistory.withScope(nextScope),
    }),
  };
}

/**
 * Create route-independent durable chat endpoint capabilities.
 *
 * SQLite resolution is deferred until the first request bound to an
 * application scope. Memory and custom stores are resolved synchronously.
 */
export function createDurableChatEndpoints(config: DurableChatHandlerConfig): DurableChatEndpoints {
  if (!config.storage) {
    throw new TypeError("Durable chat storage is required");
  }
  if (config.storage.kind === "sqlite") {
    assertChatSqliteStorageVariant(config.storage);
  }
  const composition = resolveDurableChatComposition(config);

  const immediateBundle =
    isScopedChatStorage(config.storage)
      ? undefined
      : createResolvedDurableChatEndpoints(
          config,
          composition,
          resolveImmediateChatStorage(config.storage),
        );
  const scopedBundles = new WeakMap<Scope, Promise<ResolvedEndpointBundle>>();

  const bundleForScope = (scope: Scope): Promise<ResolvedEndpointBundle> => {
    const current = scopedBundles.get(scope);
    if (current) {
      return current;
    }
    const resolving = isScopedChatStorage(config.storage)
      ? chatStorageForScope(config.storage, scope).then((storage) => {
          const bundle = createResolvedDurableChatEndpoints(config, composition, storage);
          return {
            endpoints: bindEndpointSet(bundle.endpoints, scope),
            inspection: bundle.inspection,
          };
        })
      : Promise.resolve({
            endpoints: bindEndpointSet(immediateBundle!.endpoints, scope),
            inspection: immediateBundle!.inspection,
          });
    scopedBundles.set(scope, resolving);
    return resolving;
  };

  const deferredEndpoint = <Input>(
    select: (endpoints: DurableChatEndpointSet) => ScopedEndpoint<Input>,
  ): ScopedEndpoint<Input> => {
    const endpoint = async (input: Input): Promise<Response> => {
      if (!immediateBundle) {
        throw new Error(
          "SQLite durable chat endpoints must be bound to an application-owned scope",
        );
      }
      return select(immediateBundle.endpoints)(input);
    };
    endpoint.withScope =
      (scope: Scope) =>
      async (input: Input): Promise<Response> =>
        select((await bundleForScope(scope)).endpoints)(input);
    return endpoint;
  };

  return {
    postChat: deferredEndpoint((endpoints) => endpoints.postChat),
    readChat: deferredEndpoint((endpoints) => endpoints.readChat),
    pageHistory: deferredEndpoint((endpoints) => endpoints.pageHistory),
    inspect: (scope) => bundleForScope(scope).then((bundle) => bundle.inspection),
  };
}

/**
 * Build an endpoint set over one already-resolved authority composition.
 *
 * The handler:
 * 1. Normalizes a native command or cursor-free reconnect body.
 * 2. Runs request setup in the Host-owned scope.
 * 3. Selects durable conversation authority and an internal response tail.
 * 4. Streams direct validated native values.
 *
 * @param config - Handler configuration
 * @returns Fetch handler function
 */
function createResolvedDurableChatEndpoints(
  config: DurableChatHandlerConfig,
  composition: ResolvedDurableChatComposition,
  storage: ResolvedChatStorage,
): ResolvedEndpointBundle {
  const { setup, maxToolIterations = 10 } = config;
  const { executionStore, conversationStore } = storage;
  const projectionTokens = composition.projectionTokens;
  const programDriverJournalStore = composition.createJournalStore(executionStore);
  const checkpointTargets = storage.profile === "low" ? LOW_CHECKPOINT_TARGETS : undefined;
  const liveProgramActivations = new Map<string, LiveProgramActivation>();
  const streamingEndpoint = createStreamingEndpoint<ChatStreamInvocation>(
    function* (invocation, responseContext) {
      const request = invocation.request;
      const ctx: HandlerContext = {
        request,
        headers: responseContext.headers,
        get status() {
          return responseContext.status;
        },
        set status(value: number) {
          responseContext.status = value;
        },
      };
      const bindingSource = createBindingSource(request);
      const { conversationId: requestedConversationIdParam } = durableParamsBinder(bindingSource);
      const submittedBody = request.body
        ? parseChatRequestBody(yield* readBoundedChatRequest(request))
        : ({ messages: [] } as ChatRequestBody);
      if (invocation.kind === "post-chat" && !submittedBody.command) {
        throw new CrankError("invalid_chat_request", "POST chat requests require a command");
      }
      if (invocation.kind === "read-chat" && submittedBody.command) {
        throw new CrankError("invalid_chat_request", "Chat read requests cannot carry a command");
      }
      const body: ChatRequestBody =
        invocation.kind === "post-chat"
          ? submittedBody
          : {
              ...submittedBody,
              conversationId: invocation.conversationId,
              ...(invocation.knownWindowToken
                ? { knownWindowToken: invocation.knownWindowToken }
                : {}),
            };
      const clientConversationId =
        invocation.kind === "read-chat"
          ? invocation.conversationId.trim()
          : body.conversationId?.trim() ||
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
      yield* installChatStorageDrivers(storage);
      const selectedHead = yield* ConversationStoreApi.operations.loadHead(requestedConversationId);
      // From here on, request-path store access flows through the port
      // facades so the API middleware chain applies uniformly.
      const stores = {
        conversation: yield* useConversationStore(),
        execution: yield* useExecutionStore(),
      };
      const selectedActiveExecutionId = selectedHead?.activeExecutionId;
      const turnOwner: DurableTurnOwner = yield* createDurableTurnOwner(hostOwner, function* () {
        yield* HandlerContext.set(ctx);
        yield* installChatStorageDrivers(storage);
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
                const shouldResolveConversation =
                  requestedConversationId !== undefined && !body.command;
                const resolvedHead = shouldResolveConversation ? selectedHead : null;
                const storedConversationCheckpoint =
                  shouldResolveConversation && resolvedHead?.checkpoint
                    ? yield* stores.conversation.getCheckpoint(resolvedHead.checkpoint)
                    : null;
                if (
                  shouldResolveConversation &&
                  !storedConversationCheckpoint &&
                  !resolvedHead?.activeExecutionId
                ) {
                  ctx.status = 404;
                  return yield* createEmptyStream();
                }

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
                  body.command?.commandId ??
                    activeResponseTailId ??
                    resolvedHead?.revision ??
                    "hydrate",
                ]);
                const isReconnect =
                  !body.command &&
                  (resolvedHead?.state === "running" || resolvedHead?.state === "recovering");

                ctx.headers.set("Cache-Control", "private, no-store");

                // Get logger after hooks run (so setupLogger has executed)
                const log = yield* useLogger("handler:durable");
                log.debug(
                  {
                    sessionId,
                    conversationId: requestedConversationId,
                    endpoint: invocation.kind,
                    isReconnect,
                    messageCount: body.messages.length,
                  },
                  "request received",
                );

                if (body.command) {
                  const now = Date.now();
                  if (body.command.expiresAt <= now) {
                    return yield* createConversationCommandErrorResponse({
                      conversationId: requestedConversationId,
                      code: "command_expired",
                      message: `Command ${body.command.commandId} expired before admission`,
                    });
                  }
                  if (body.command.issuedAt > now + 60_000) {
                    return yield* createConversationCommandErrorResponse({
                      conversationId: requestedConversationId,
                      code: "command_issued_in_future",
                      message: `Command ${body.command.commandId} issue time is not credible`,
                    });
                  }
                }
                const selectedCommandReceipt = body.command
                  ? yield* stores.conversation.getCommandReceipt(
                      requestedConversationId,
                      body.command.commandId,
                    )
                  : null;
                // Fast rejection keeps a new ordinary command away from resume
                // planning while a Turn is visibly active. Exact retries skip
                // this optimization so the store can check receipt identity
                // before revision and state preconditions.
                if (
                  selectedCommandReceipt === null &&
                  body.command &&
                  (body.command.type === "send-message" || body.command.type === "regenerate")
                ) {
                  const selectedRevision = selectedHead?.revision ?? null;
                  if (body.command.basisRevision !== selectedRevision) {
                    return yield* createConversationCommandErrorResponse({
                      conversationId: requestedConversationId,
                      code: "conversation_state_changed",
                      message: `Conversation ${requestedConversationId} changed after revision ${String(body.command.basisRevision)}`,
                    });
                  }
                  if (selectedHead !== null && selectedHead.state !== "idle") {
                    return yield* createConversationCommandErrorResponse({
                      conversationId: requestedConversationId,
                      code: "conversation_not_idle",
                      message: `Conversation ${requestedConversationId} is not idle`,
                    });
                  }
                }

                if (
                  shouldResolveConversation &&
                  resolvedHead &&
                  storedConversationCheckpoint &&
                  resolvedHead.state !== "running" &&
                  resolvedHead.state !== "recovering"
                ) {
                  const window = yield* buildConversationWindow({
                    conversationId: requestedConversationId!,
                    head: resolvedHead,
                    checkpoint: storedConversationCheckpoint,
                    keyring: projectionTokens,
                    ...(body.knownWindowToken ? { knownWindowToken: body.knownWindowToken } : {}),
                    ...(config.projectionTokenTtlMs === undefined
                      ? {}
                      : { tokenTtlMs: config.projectionTokenTtlMs }),
                  });
                  return yield* createStoredConversationCheckpointResponse({
                    conversationId: requestedConversationId!,
                    head: resolvedHead,
                    window,
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
                  // A response cursor selects presentation replay only. If its
                  // writer is detached while durable authority remains active,
                  // release this reader and offer the session a fenced recovery
                  // source instead of treating the incomplete buffer as truth.
                  log.debug({ sessionId }, "reconnect path: acquiring existing session");
                  session = yield* registry.acquire(sessionId);
                  const responseComplete = yield* session.buffer.isComplete();
                  recoverDetachedSession =
                    Boolean(resolvedHead?.activeExecutionId) &&
                    selectedLiveActivation?.executionId !== resolvedHead?.activeExecutionId &&
                    !responseComplete;
                  if (recoverDetachedSession) {
                    yield* registry.release(sessionId);
                    session = undefined;
                    log.debug({ sessionId }, "reconnect path: detached writer requires recovery");
                  } else {
                    log.debug({ sessionId }, "reconnect path: session acquired");
                    const reconnectHead =
                      yield* stores.conversation.loadHead(requestedConversationId);
                    const reconnectCheckpoint = reconnectHead?.checkpoint
                      ? yield* stores.conversation.getCheckpoint(reconnectHead.checkpoint)
                      : null;
                    if (
                      !reconnectHead ||
                      !reconnectCheckpoint ||
                      !reconnectHead.activeLogicalTurnId
                    ) {
                      throw new CrankError(
                        "conversation_state_changed",
                        `Conversation ${requestedConversationId} lost its active reconnect state`,
                      );
                    }
                    if (!session.buffer.readLatest) {
                      throw new Error(
                        "Response tail does not support bounded latest-position reads",
                      );
                    }
                    responseStartLSN = (yield* session.buffer.readLatest()).lsn;
                    responsePrefix = [
                      {
                        type: EventType.RUN_STARTED,
                        threadId: agUiThreadId,
                        runId: reconnectHead.activeLogicalTurnId,
                        input: {
                          threadId: agUiThreadId,
                          runId: reconnectHead.activeLogicalTurnId,
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
                      },
                      yield* buildConversationWindow({
                        conversationId: requestedConversationId,
                        head: reconnectHead,
                        checkpoint: reconnectCheckpoint,
                        keyring: projectionTokens,
                        ...(body.knownWindowToken
                          ? { knownWindowToken: body.knownWindowToken }
                          : {}),
                        ...(config.projectionTokenTtlMs === undefined
                          ? {}
                          : { tokenTtlMs: config.projectionTokenTtlMs }),
                      }),
                      conversationAuthorityFrame(requestedConversationId, reconnectHead),
                    ];
                  }
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
                    ? (authoritativeMessages.find((entry) => entry.id === sendCommand.messageId) ??
                      null)
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
                          ...toProviderHistorySnapshot(body.messages).map(
                            acceptedPublicMessageFact,
                          ),
                          assertJson(runStartedEvent),
                        ],
                        logicalTurnId: selectedHead?.activeLogicalTurnId ?? agUiRunId,
                        executionId:
                          selectedHead?.activeExecutionId ??
                          `chat-turn:${requestedConversationId}:${agUiRunId}`,
                        ...(checkpointTargets ? { targets: checkpointTargets } : {}),
                        expectedRevision:
                          body.command?.basisRevision ?? selectedHead?.revision ?? null,
                        ...(selectedHead?.ownerEpoch
                          ? { expectedOwnerEpoch: selectedHead.ownerEpoch }
                          : {}),
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
                      if (
                        error instanceof CrankError &&
                        error.code === "command_already_terminal"
                      ) {
                        const retryHead =
                          yield* stores.conversation.loadHead(requestedConversationId);
                        const retryCheckpoint = retryHead?.checkpoint
                          ? yield* stores.conversation.getCheckpoint(retryHead.checkpoint)
                          : null;
                        if (retryCheckpoint && retryHead) {
                          const retryWindow = yield* buildConversationWindow({
                            conversationId: requestedConversationId,
                            head: retryHead,
                            checkpoint: retryCheckpoint,
                            keyring: projectionTokens,
                            ...(body.knownWindowToken
                              ? { knownWindowToken: body.knownWindowToken }
                              : {}),
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
                    if (
                      activeRecord &&
                      activeRecord.format !== "sweatpants.terminal-execution.v1"
                    ) {
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
                    if (
                      !activeRecord ||
                      activeRecord.format === "sweatpants.terminal-execution.v1"
                    ) {
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
                  const programDriverEphemeralEffects =
                    yield* useOptionalProgramDriverEphemeralEffects();
                  const programDriverNativeTools = yield* useOptionalProgramDriverNativeTools();

                  // Create the chat engine. If public resume validation failed, use an
                  // empty engine and expose the failure as a schema-valid RUN_ERROR before
                  // any replay projection or runtime continuation can occur.
                  const respondCommand =
                    body.command?.type === "respond-to-elicit" ? body.command : null;
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
                        causeKey: stableTupleHash([
                          authorityTurn.executionId,
                          "nonterminal",
                          admissionFacts,
                        ]),
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
                    ...(plan.initialToolChoice
                      ? { initialToolChoice: plan.initialToolChoice }
                      : {}),
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
                      const failure =
                        error ?? new Error("Live activation settled before terminal publication");
                      liveActivation?.taskReady.reject(failure);
                      liveActivation?.terminal.reject(failure);
                      if (liveProgramActivations.get(requestedConversationId) === liveActivation) {
                        liveProgramActivations.delete(requestedConversationId);
                      }
                    },
                    ...(shouldResolveConversation && !body.command ? { recoveryOnly: true } : {}),
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
                    publishCheckpoint: function* ({ events }) {
                      if (!authorityTurn) {
                        throw new Error("Parked checkpoint has no authoritative Turn");
                      }
                      const parkedHead = yield* stores.conversation.loadHead(requestedConversationId);
                      if (
                        !parkedHead ||
                        parkedHead.activeExecutionId !== authorityTurn.executionId
                      ) {
                        throw new Error("Parked checkpoint lost its authoritative Turn");
                      }
                      const encodedEvents = events.map((event) => assertJson(event));
                      const persisted = yield* persistConversationCheckpoint({
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
                      return {
                        authority: conversationAuthority(requestedConversationId, persisted.head),
                        ...(projectionTokens
                          ? {
                              window: yield* buildConversationWindow({
                                conversationId: requestedConversationId,
                                head: persisted.head,
                                checkpoint: persisted.checkpoint,
                                keyring: projectionTokens,
                                ...(body.knownWindowToken
                                  ? { knownWindowToken: body.knownWindowToken }
                                  : {}),
                                ...(config.projectionTokenTtlMs === undefined
                                  ? {}
                                  : { tokenTtlMs: config.projectionTokenTtlMs }),
                              }),
                            }
                          : {}),
                      };
                    },
                    publishTerminal: function* ({ outcome, disposition, events }) {
                      if (!authorityTurn) {
                        throw new Error(
                          "Recovered terminal publication cannot execute workflow host",
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
                      const terminalHead =
                        yield* stores.conversation.loadHead(requestedConversationId);
                      if (disposition === "cancelled") {
                        cancelOpenInterruptsForThread(agUiThreadId);
                      }
                      liveActivation?.terminal.resolve(undefined);
                      const terminalCheckpoint = terminalHead?.checkpoint
                        ? yield* stores.conversation.getCheckpoint(terminalHead.checkpoint)
                        : null;
                      return {
                        authority: conversationAuthority(requestedConversationId, terminalHead),
                        ...(terminalHead && terminalCheckpoint
                          ? {
                              window: yield* buildConversationWindow({
                                conversationId: requestedConversationId,
                                head: terminalHead,
                                checkpoint: terminalCheckpoint,
                                keyring: projectionTokens,
                                ...(body.knownWindowToken
                                  ? { knownWindowToken: body.knownWindowToken }
                                  : {}),
                                ...(config.projectionTokenTtlMs === undefined
                                  ? {}
                                  : { tokenTtlMs: config.projectionTokenTtlMs }),
                              }),
                            }
                          : {}),
                      };
                    },
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
                            ...(programDriverNativeTools
                              ? { nativeTools: programDriverNativeTools }
                              : {}),
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
                    throw new Error(
                      `Conversation ${requestedConversationId} running checkpoint is missing`,
                    );
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
                  initialEvents.push(
                    conversationAuthorityFrame(requestedConversationId, authorityHead),
                  );

                  // Acquire the one Host-owned response buffer before constructing the
                  // pull source. workflow host is turned only when this sole writer asks
                  // the engine for its next event; live model activity appends directly
                  // to the same reconnectable buffer from inside that crank turn.
                  log.debug({ sessionId }, "new session path: acquiring session with source");
                  session = yield* registry.acquire(sessionId, {
                    writer: nextResponseWriterFence(sessionId),
                    recoverIfDetached: shouldResolveConversation,
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
        // Setup failures are direct pre-admission rejection events.
        const errorEvent = {
          type: EventType.RUN_ERROR,
          message: error.message,
          code: error instanceof CrankError ? error.code : "internal_error",
        };
        const body = JSON.stringify(errorEvent) + "\n";
        return new Response(body, {
          status: 200, // Stream "succeeded" but contains error event
          headers: ctx.headers,
        });
      },
    },
  );
  const postChat = mapScopedEndpoint<Request, ChatStreamInvocation>(
    streamingEndpoint,
    (request) => ({ kind: "post-chat", request }),
  );
  const readChat = mapScopedEndpoint<DurableChatReadRequest, ChatStreamInvocation>(
    streamingEndpoint,
    (request) => ({ kind: "read-chat", ...request }),
  );
  const pageHistory = createDurableHistoryPageEndpoint(
    {
      projectionTokens,
      authorizeHistoryRead: composition.authorizeHistoryRead,
      ...(config.projectionTokenTtlMs === undefined
        ? {}
        : { projectionTokenTtlMs: config.projectionTokenTtlMs }),
    },
    conversationStore,
  );
  return {
    endpoints: { postChat, readChat, pageHistory },
    inspection: { conversationStore, executionStore, programDriverJournalStore },
  };
}

/** Backward-compatible name for the route-specific POST chat endpoint. */
export function createDurableChatHandler(
  config: DurableChatHandlerConfig,
): ScopedEndpoint<Request> {
  return createDurableChatEndpoints(config).postChat;
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
