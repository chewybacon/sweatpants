import { randomUUID } from "node:crypto";
import {
  call,
  createContext,
  createScope,
  resource,
  sleep,
  type Operation,
  type Scope,
  type Stream,
  type Subscription,
} from "effection";
import {
  CrankError,
  DurableEffectRegistryContext,
  withJournalAuthority,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createLocalProgramDriver,
  createProgramDriverRegistry,
  sha256,
  stableProgramAttachmentId,
  type DurableEffectRegistration,
  type DurableOperationDescriptor,
  type DurableSemanticRecord,
  type DurableTool,
  type Json,
  type ProgramRunResult,
  type SerializedApplicationError,
} from "@sweatpants/session-contract";
import {
  createInMemoryImmutableContentStore,
  parseForeignA2AMessage,
  putVerifiedContent,
  type A2AContentReference,
  type ForeignA2AArtifact,
  type ForeignA2AMessage,
  type ForeignA2ANormalizedState,
  type ForeignA2ATask,
  type ImmutableContentStore,
} from "@sweatpants/a2a";
import type { AgentDefinition, AgentProgramBinding } from "@sweatpants/core";
import {
  acceptChatTurn,
  normalizeChatMessage,
  normalizeChatTurnInput,
  normalizeChatTurnResult,
  type ChatMessageV1,
  type ChatProgramDefinition,
  type ChatTurnInputV1,
  type ChatTurnResultV1,
  type ReferencedTaskSummaryV1,
} from "../lib/chat/authoring/index.ts";
import {
  createInMemoryProgramDriverJournalStore,
  programDriverSchemaRegistry,
  type ProgramDriverJournal,
  type ProgramDriverJournalStore,
} from "../handler/durable/program-driver-journal.ts";
import type { PublicAgentDeployment } from "./agent-profiles.ts";

export const StandardA2ATraceContext = createContext<
  { readonly traceparent: string; readonly tracestate?: string } | undefined
>("standard-a2a:trace-context", undefined);

export type StandardA2AHostErrorCode =
  | "standard_profile_incompatible"
  | "authentication_failed"
  | "authorization_denied"
  | "context_not_found"
  | "task_not_found"
  | "task_context_mismatch"
  | "task_not_modifiable"
  | "message_idempotency_conflict"
  | "task_reference_invalid"
  | "task_input_too_large"
  | "request_invalid"
  | "content_digest_conflict"
  | "content_unavailable"
  | "content_expired"
  | "model_egress_forbidden"
  | "insecure_production_transport";

export class StandardA2AHostError extends CrankError {
  readonly _standardA2AHostTag = "StandardA2AHostError";
  constructor(
    code: StandardA2AHostErrorCode,
    message: string,
    readonly httpStatus = hostStatus(code),
  ) {
    super(code, message);
    this.name = "StandardA2AHostError";
  }
}

export interface StandardA2ARequestContext {
  readonly principalId: string;
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
}

export type StandardA2AAuthorizationAction =
  | "card:read"
  | "message:send"
  | "task:read"
  | "task:continue"
  | "task:cancel"
  | "task:subscribe"
  | "content:read";

export interface StandardA2ARetentionPolicy {
  readonly taskSeconds: number;
  readonly messageHistorySeconds: number;
  readonly messageIdempotencySeconds: number;
  readonly eventSeconds: number;
  readonly contentSeconds: number;
}

export interface StandardA2AHostLimits {
  readonly maxReferences: number;
  readonly maxHistoryLength: number;
  readonly maxRequestBytes: number;
}

export type StandardA2AHistoryProjection = "task-only" | "accepted-context";

export interface StandardA2AHostBinding {
  readonly definition: AgentDefinition;
  readonly card: Json;
  readonly deployment: PublicAgentDeployment;
  readonly handlers: readonly DurableEffectRegistration[];
  readonly historyProjection: StandardA2AHistoryProjection;
}

export interface StandardA2AHostPort {
  readonly kind: "standard-a2a-task-host.v1";
  readonly services: Json;
  bind?(binding: StandardA2AHostBinding): BoundStandardA2AHost;
  check?(): Promise<void>;
}

export type StandardA2AStreamEvent =
  | { readonly kind: "task"; readonly task: ForeignA2ATask }
  | {
      readonly kind: "artifact-update";
      readonly taskId: string;
      readonly contextId: string;
      readonly artifact: ForeignA2AArtifact;
      readonly append: boolean;
      readonly lastChunk: boolean;
    }
  | {
      readonly kind: "status-update";
      readonly taskId: string;
      readonly contextId: string;
      readonly state: ForeignA2ANormalizedState;
      readonly message?: ForeignA2AMessage;
      readonly final: boolean;
    };

export interface BoundStandardA2AHost extends StandardA2AHostPort {
  readonly readiness: boolean;
  readonly card: Json;
  handle(request: Request, context?: StandardA2ARequestContext): Promise<Response>;
  sendMessage(
    message: ForeignA2AMessage,
    context: StandardA2ARequestContext,
  ): Operation<ForeignA2ATask>;
  streamMessage(
    message: ForeignA2AMessage,
    context: StandardA2ARequestContext,
  ): Stream<StandardA2AStreamEvent, void>;
  getTask(
    taskId: string,
    context: StandardA2ARequestContext,
    historyLength?: number,
  ): Operation<ForeignA2ATask>;
  cancelTask(taskId: string, context: StandardA2ARequestContext): Operation<ForeignA2ATask>;
  subscribeTask(
    taskId: string,
    context: StandardA2ARequestContext,
  ): Stream<StandardA2AStreamEvent, void>;
  evidence(contextId: string, context: StandardA2ARequestContext): Operation<StandardA2AEvidence>;
}

export interface StandardA2AEvidence {
  readonly contextId: string;
  readonly acceptedMessages: number;
  readonly tasks: readonly {
    readonly taskId: string;
    readonly state: ForeignA2ANormalizedState;
    readonly referenceTaskIds: readonly string[];
  }[];
  readonly journal: readonly {
    readonly offset: string;
    readonly type: DurableSemanticRecord["payload"]["type"];
    readonly taskId?: string;
  }[];
  readonly contentReferences: readonly StandardA2AExternalContentBinding[];
  readonly operations: readonly {
    readonly taskId: string;
    readonly pullId: string;
    readonly kind:
      | "effect"
      | "record"
      | "invoke"
      | "elicit"
      | "wait"
      | "all"
      | "race"
      | "spawn"
      | "join";
    readonly target: string;
    readonly state: "pending" | "resolved";
  }[];
}

export interface StandardA2ATaskDirectoryEntry {
  readonly taskId: string;
  readonly contextId: string;
  readonly ownerScope: string;
}
export interface StandardA2AExternalContentBinding {
  readonly taskId: string;
  readonly artifactId: string;
  readonly partIndex: number;
  readonly reference: A2AContentReference;
}
export interface StandardA2AContinuationBinding {
  readonly taskId: string;
  readonly messageId: string;
  readonly messageDigest: string;
  readonly pullId: string;
}

/** Routing index only; every lookup is verified against the context journal. */
export interface StandardA2ATaskDirectory {
  bind(entry: StandardA2ATaskDirectoryEntry): Operation<"bound" | "duplicate">;
  lookup(taskId: string): Operation<StandardA2ATaskDirectoryEntry | undefined>;
  bindContinuation(binding: StandardA2AContinuationBinding): Operation<"bound" | "duplicate">;
  lookupContinuation(
    taskId: string,
    messageId: string,
  ): Operation<StandardA2AContinuationBinding | undefined>;
  continuationsForTask(taskId: string): Operation<readonly StandardA2AContinuationBinding[]>;
  bindContent(binding: StandardA2AExternalContentBinding): Operation<"bound" | "duplicate">;
  contentForTask(taskId: string): Operation<readonly StandardA2AExternalContentBinding[]>;
  lookupContent(digest: string): Operation<StandardA2AExternalContentBinding | undefined>;
  check?(): Operation<void>;
}

export function createInMemoryStandardA2ATaskDirectory(): StandardA2ATaskDirectory {
  const entries = new Map<string, StandardA2ATaskDirectoryEntry>();
  const continuations = new Map<string, StandardA2AContinuationBinding>();
  const content = new Map<string, StandardA2AExternalContentBinding>();
  return {
    *bind(entry) {
      const existing = entries.get(entry.taskId);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(entry)) {
          throw hostError("standard_profile_incompatible", "Task directory identity conflict");
        }
        return "duplicate";
      }
      entries.set(entry.taskId, Object.freeze({ ...entry }));
      return "bound";
    },
    *lookup(taskId) {
      const entry = entries.get(taskId);
      return entry ? Object.freeze({ ...entry }) : undefined;
    },
    *bindContinuation(binding) {
      const key = `${binding.taskId}\0${binding.messageId}`;
      const existing = continuations.get(key);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(binding)) {
          throw hostError("message_idempotency_conflict", "Continuation identity was reused");
        }
        return "duplicate";
      }
      continuations.set(key, Object.freeze({ ...binding }));
      return "bound";
    },
    *lookupContinuation(taskId, messageId) {
      const binding = continuations.get(`${taskId}\0${messageId}`);
      return binding ? Object.freeze({ ...binding }) : undefined;
    },
    *continuationsForTask(taskId) {
      return [...continuations.values()].filter((binding) => binding.taskId === taskId);
    },
    *bindContent(binding) {
      const key = `${binding.taskId}\0${binding.artifactId}\0${binding.partIndex}`;
      const existing = content.get(key);
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(binding)) {
          throw hostError("content_digest_conflict", "Content association identity conflict");
        }
        return "duplicate";
      }
      content.set(key, Object.freeze(structuredClone(binding)));
      return "bound";
    },
    *contentForTask(taskId) {
      return [...content.values()].filter((binding) => binding.taskId === taskId);
    },
    *lookupContent(digest) {
      return [...content.values()].find((binding) => binding.reference.digest === digest);
    },
    *check() {},
  };
}

export interface StandardA2ATelemetryEvent {
  readonly type: "request" | "state" | "error";
  readonly action?: StandardA2AAuthorizationAction;
  readonly taskId?: string;
  readonly contextId?: string;
  readonly state?: ForeignA2ANormalizedState;
  readonly code?: string;
}

export interface CreateStandardA2AHostOptions {
  readonly journalStore?: ProgramDriverJournalStore;
  readonly taskDirectory?: StandardA2ATaskDirectory;
  readonly contentStore?: ImmutableContentStore;
  readonly retention?: Partial<StandardA2ARetentionPolicy>;
  readonly limits?: Partial<StandardA2AHostLimits>;
  readonly now?: () => number;
  readonly generateContextId?: () => string;
  readonly generateTaskNonce?: () => string;
  readonly allowClientContextIds?: boolean;
  readonly allowAnonymousDevelopment?: boolean;
  readonly authenticate?: (request: Request) => Operation<StandardA2ARequestContext | undefined>;
  readonly authorize?: (input: {
    readonly context: StandardA2ARequestContext;
    readonly action: StandardA2AAuthorizationAction;
    readonly contextId?: string;
    readonly taskId?: string;
  }) => Operation<boolean>;
  readonly challenge?: string;
  readonly inputClassification?: "public" | "internal" | "confidential" | "restricted";
  /** Artifact parts at or above this byte size are served from immutable custody. */
  readonly externalContentThresholdBytes?: number;
  readonly onTelemetry?: (event: StandardA2ATelemetryEvent) => void;
}

const DEFAULT_RETENTION: StandardA2ARetentionPolicy = Object.freeze({
  taskSeconds: 24 * 60 * 60,
  messageHistorySeconds: 24 * 60 * 60,
  messageIdempotencySeconds: 24 * 60 * 60,
  eventSeconds: 24 * 60 * 60,
  contentSeconds: 24 * 60 * 60,
});
const DEFAULT_LIMITS: StandardA2AHostLimits = Object.freeze({
  maxReferences: 32,
  maxHistoryLength: 1_000,
  maxRequestBytes: 2 * 1024 * 1024,
});
const TERMINAL = new Set<ForeignA2ANormalizedState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);

/** Creates an unbound framework-neutral host port. serveAgent binds exact agent/card data. */
export function createStandardA2AHost(
  options: CreateStandardA2AHostOptions = {},
): StandardA2AHostPort {
  const retention = normalizeRetention(options.retention);
  const limits = normalizeLimits(options.limits);
  const contentStore = options.contentStore ?? createInMemoryImmutableContentStore(options.now);
  const taskDirectory = options.taskDirectory ?? createInMemoryStandardA2ATaskDirectory();
  return Object.freeze({
    kind: "standard-a2a-task-host.v1" as const,
    services: assertJson(
      Object.freeze({
        binding: "HTTP+JSON",
        operations: Object.freeze([
          "agent-card",
          "message/send",
          "tasks/get",
          "tasks/cancel",
          "tasks/subscribe",
        ]),
        taskGenerating: true,
        streaming: true,
      }),
    ),
    bind(binding: StandardA2AHostBinding) {
      return bindStandardHost(binding, {
        ...options,
        retention,
        limits,
        contentStore,
        taskDirectory,
      });
    },
    async check() {
      await Promise.all([contentStore.check?.(), checkTaskDirectory(taskDirectory)]);
    },
  });
}

type BoundHostOptions = CreateStandardA2AHostOptions & {
  retention: StandardA2ARetentionPolicy;
  limits: StandardA2AHostLimits;
  contentStore: ImmutableContentStore;
  taskDirectory: StandardA2ATaskDirectory;
};

function bindStandardHost(
  binding: StandardA2AHostBinding,
  options: BoundHostOptions,
): BoundStandardA2AHost {
  const conversation = requireConversation(binding.definition);
  const authored = conversation.program as ChatProgramDefinition;
  if (authored.kind !== "sweatpants.chat-program.v1" || !authored.contextPolicy) {
    throw hostError(
      "standard_profile_incompatible",
      "Standard serving requires an authored chat conversation program",
    );
  }
  validateTransport(binding.deployment);
  const tools = allPrograms(conversation);
  const registry = createDurableToolRegistry(tools.map((item) => item.program));
  const drivers = createProgramDriverRegistry([["program", createLocalProgramDriver(registry)]]);
  const effects = createDurableEffectRegistry(binding.handlers);
  const journalStore =
    options.journalStore ??
    createInMemoryProgramDriverJournalStore({
      keyring: createCapabilityKeyring(
        `standard-a2a:${binding.definition.manifest.identity.digest}`,
        [{ keyId: "process", secret: `${randomUUID()}${randomUUID()}` }],
      ),
      journalPrefix: "standard-a2a",
      ...(options.now ? { now: options.now } : {}),
      schemaRegistry: programDriverSchemaRegistry(binding.definition.bindings.schemas),
    });
  const locks = new Map<string, Promise<void>>();

  function* hostedProjection(
    records: readonly DurableSemanticRecord[],
    taskId: string,
    contextId: string,
    historyLength: number,
  ): Operation<ForeignA2ATask> {
    const bindings = yield* custodyTaskArtifacts(records, taskId, options);
    const continuations = yield* options.taskDirectory.continuationsForTask(taskId);
    return externalizeTask(
      projectTask(
        records,
        taskId,
        contextId,
        historyLength,
        binding.historyProjection,
        continuations,
      ),
      bindings,
      binding.deployment.interfaceUrl,
    );
  }

  const host: BoundStandardA2AHost = {
    kind: "standard-a2a-task-host.v1",
    services: assertJson(
      Object.freeze({
        binding: "HTTP+JSON",
        operations: Object.freeze([
          "agent-card",
          "message/send",
          "tasks/get",
          "tasks/cancel",
          "tasks/subscribe",
        ]),
        taskGenerating: true,
        streaming: true,
      }),
    ),
    readiness: true,
    card: binding.card,
    bind() {
      return host;
    },
    async check() {
      await Promise.all([
        options.contentStore.check?.(),
        checkTaskDirectory(options.taskDirectory),
      ]);
    },
    *sendMessage(messageValue, requestContext): Operation<ForeignA2ATask> {
      const message = parseForeignA2AMessage(messageValue);
      if (message.role !== "user") {
        throw hostError("standard_profile_incompatible", "Only user messages may be sent");
      }
      const targetEntry = message.taskId
        ? yield* lookupAuthorizedTask(options.taskDirectory, message.taskId, requestContext)
        : undefined;
      const targetContext = targetEntry?.contextId ?? message.contextId;
      yield* authorize(options, requestContext, message.taskId ? "task:continue" : "message:send", {
        ...(targetContext ? { contextId: targetContext } : {}),
        ...(message.taskId ? { taskId: message.taskId } : {}),
      });
      if (message.taskId && targetEntry) {
        return yield* withLock(
          locks,
          scopedSession(requestContext, targetEntry.contextId),
          function* () {
            return yield* continueTask(message, requestContext, targetEntry.contextId);
          },
        );
      }
      const contextId = resolveContextId(message.contextId, options);
      return yield* withLock(locks, scopedSession(requestContext, contextId), function* () {
        const journal = yield* openJournal(journalStore, requestContext, contextId);
        const before = yield* readJournal(journal, scopedSession(requestContext, contextId));
        if (message.contextId && before.length === 0 && !options.allowClientContextIds) {
          throw hostError("context_not_found", "Client context identities are not accepted");
        }
        const existing = findRootByMessageId(before, message.messageId);
        if (existing) {
          assertIdempotentMessage(existing, message, contextId);
          return yield* hostedProjection(
            before,
            existing.taskId,
            contextId,
            options.limits.maxHistoryLength,
          );
        }
        const references = stableReferences(message.referenceTaskIds ?? [], options.limits);
        const roots = rootOpenings(before);
        for (const reference of references) {
          if (!roots.some((candidate) => candidate.taskId === reference)) {
            throw hostError(
              "task_reference_invalid",
              "A task reference is unavailable in this authorized context",
            );
          }
        }
        const inputMessage = wireToChatMessage(message, options.inputClassification ?? "public");
        const referencedTasks = references.map((taskId) => referencedSummary(before, taskId));
        const input = acceptTurn(authored, inputMessage, {
          frontier: before.at(-1)?.offset ?? "0",
          referenceTaskIds: references,
          referencedTasks,
          messages: contextMessages(before),
        });
        const taskId = `task_${safeNonce(options.generateTaskNonce?.() ?? randomUUID())}`;
        yield* options.taskDirectory.bind({
          taskId,
          contextId,
          ownerScope: requestOwnerScope(requestContext),
        });
        yield* withRequestTrace(requestContext, function* () {
          return yield* openAndRun({
            journal,
            sessionId: scopedSession(requestContext, contextId),
            taskId,
            input,
            conversation,
            drivers,
            effects,
          });
        });
        const after = yield* readJournal(journal, scopedSession(requestContext, contextId));
        const task = yield* hostedProjection(
          after,
          taskId,
          contextId,
          options.limits.maxHistoryLength,
        );
        options.onTelemetry?.({
          type: "state",
          contextId,
          taskId,
          state: task.status.state,
        });
        return task;
      });
    },
    streamMessage(message, requestContext) {
      return taskUpdateStream(() => host.sendMessage(message, requestContext));
    },
    *getTask(taskId, requestContext, historyLength): Operation<ForeignA2ATask> {
      const { contextId } = yield* lookupAuthorizedTask(
        options.taskDirectory,
        taskId,
        requestContext,
      );
      yield* authorize(options, requestContext, "task:read", { contextId, taskId });
      const journal = yield* openJournal(journalStore, requestContext, contextId);
      const records = yield* readJournal(journal, scopedSession(requestContext, contextId));
      return yield* hostedProjection(
        records,
        taskId,
        contextId,
        normalizeHistoryLength(historyLength, options.limits),
      );
    },
    *cancelTask(taskId, requestContext): Operation<ForeignA2ATask> {
      const { contextId } = yield* lookupAuthorizedTask(
        options.taskDirectory,
        taskId,
        requestContext,
      );
      yield* authorize(options, requestContext, "task:cancel", { contextId, taskId });
      const sessionId = scopedSession(requestContext, contextId);
      const journal = yield* openJournal(journalStore, requestContext, contextId);
      const before = yield* readJournal(journal, sessionId);
      const current = yield* hostedProjection(
        before,
        taskId,
        contextId,
        options.limits.maxHistoryLength,
      );
      if (TERMINAL.has(current.status.state)) {
        if (current.status.state === "canceled") {
          return current;
        }
        throw hostError("task_not_modifiable", "Terminal task cannot be canceled");
      }
      // Cancellation deliberately bypasses the per-context new-turn lock: the
      // journal authority records the exact-task frontier first and signals a
      // live local effect without waiting for the request that owns it.
      yield* journal.requestCancellation(sessionId, taskId, "A2A cancellation requested");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const after = yield* readJournal(journal, sessionId);
        const projected = yield* hostedProjection(
          after,
          taskId,
          contextId,
          options.limits.maxHistoryLength,
        );
        if (TERMINAL.has(projected.status.state)) {
          return projected;
        }
        yield* sleep(5);
      }
      // Parked work has no live executor to observe the cancellation. Drive its
      // exact accepted input through recovery after the live grace interval.
      yield* withRequestTrace(requestContext, function* () {
        return yield* runExisting({
          journal,
          sessionId,
          taskId,
          input: taskInput(before, taskId),
          conversation,
          drivers,
          effects,
        });
      });
      return yield* hostedProjection(
        yield* readJournal(journal, sessionId),
        taskId,
        contextId,
        options.limits.maxHistoryLength,
      );
    },
    subscribeTask(taskId, requestContext) {
      return taskUpdateStream(() => host.getTask(taskId, requestContext));
    },
    *evidence(contextId, requestContext): Operation<StandardA2AEvidence> {
      yield* authorize(options, requestContext, "task:read", { contextId });
      const sessionId = scopedSession(requestContext, contextId);
      const journal = yield* openJournal(journalStore, requestContext, contextId);
      const records = yield* readJournal(journal, sessionId);
      const tasks = rootOpenings(records).map((opened) => {
        const projected = projectTask(records, opened.taskId, contextId, 0, "task-only", []);
        const input = openedTurnInput(opened);
        return Object.freeze({
          taskId: opened.taskId,
          state: projected.status.state,
          referenceTaskIds: Object.freeze([...(input.context?.referenceTaskIds ?? [])]),
        });
      });
      const contentReferences: StandardA2AExternalContentBinding[] = [];
      for (const opened of rootOpenings(records)) {
        contentReferences.push(...(yield* options.taskDirectory.contentForTask(opened.taskId)));
      }
      const operations = records.flatMap((record) => {
        const payload = record.payload;
        if (payload.type !== "PullRequested") {
          return [];
        }
        const descriptor = payload.descriptor;
        const target = descriptorTarget(descriptor);
        const resolved = records.some(
          (candidate) =>
            candidate.payload.type === "PullResolved" &&
            candidate.payload.taskId === payload.taskId &&
            candidate.payload.pullId === payload.pullId,
        );
        return [
          Object.freeze({
            taskId: payload.taskId,
            pullId: payload.pullId,
            kind: descriptor.kind,
            target,
            state: resolved ? ("resolved" as const) : ("pending" as const),
          }),
        ];
      });
      return Object.freeze({
        contextId,
        acceptedMessages: tasks.length,
        tasks: Object.freeze(tasks),
        journal: Object.freeze(
          records.map((record) => {
            const taskId = payloadTaskId(record.payload);
            return Object.freeze({
              offset: record.offset,
              type: record.payload.type,
              ...(taskId ? { taskId } : {}),
            });
          }),
        ),
        contentReferences: Object.freeze(contentReferences),
        operations: Object.freeze(operations),
      });
    },
    async handle(request, suppliedContext) {
      const [requestScope, destroyRequestScope] = createScope();
      let requestScopeTransferred = false;
      try {
        const url = new URL(request.url);
        const cardPath = url.pathname.endsWith("/.well-known/agent-card.json");
        const context =
          suppliedContext ??
          (await requestScope.run(function* () {
            return yield* authenticate(options, request);
          }));
        if (cardPath) {
          await requestScope.run(function* () {
            yield* authorize(options, context, "card:read", {});
          });
          return jsonResponse(binding.card);
        }
        const relative = relativeInterfacePath(binding.deployment.interfaceUrl, url);
        const sdk03 = isSdk03Path(binding.deployment.interfaceUrl, url);
        options.onTelemetry?.({ type: "request" });
        const contentMatch = /^content\/([0-9a-f]{64})$/.exec(relative);
        if (request.method === "GET" && contentMatch) {
          const digest = contentMatch[1]!;
          const contentBinding = await requestScope.run(function* () {
            return yield* options.taskDirectory.lookupContent(digest);
          });
          if (!contentBinding) {
            throw hostError("content_unavailable", "Content is unavailable");
          }
          await requestScope.run(function* () {
            const task = yield* lookupAuthorizedTask(
              options.taskDirectory,
              contentBinding.taskId,
              context,
            );
            yield* authorize(options, context, "content:read", {
              contextId: task.contextId,
              taskId: task.taskId,
            });
          });
          const content = await options.contentStore.get(digest);
          if (content.status === "content_expired") {
            throw hostError("content_expired", "Content retention has expired");
          }
          if (content.status !== "available") {
            throw hostError("content_unavailable", "Content is unavailable");
          }
          return new Response(Buffer.from(content.object.bytes), {
            status: 200,
            headers: {
              "content-type": contentBinding.reference.mediaType,
              "content-length": String(contentBinding.reference.size),
              etag: `"${digest}"`,
            },
          });
        }
        if (request.method === "POST" && relative === "message:send") {
          const body = await boundedBody(request, options.limits.maxRequestBytes);
          const bodyValue = bodyRecord(body);
          const message = bodyValue["message"] ?? bodyValue["request"];
          const task = await requestScope.run(function* () {
            return yield* host.sendMessage(parseIncomingMessage(message, sdk03), context);
          });
          return jsonResponse({ task: wireTask(task, sdk03) });
        }
        if (request.method === "POST" && relative === "message:stream") {
          const body = await boundedBody(request, options.limits.maxRequestBytes);
          const bodyValue = bodyRecord(body);
          const subscription = await requestScope.run(function* () {
            return yield* host.streamMessage(
              parseIncomingMessage(bodyValue["message"] ?? bodyValue["request"], sdk03),
              context,
            );
          });
          requestScopeTransferred = true;
          return pullSseResponse(requestScope, destroyRequestScope, subscription, sdk03);
        }
        const getMatch = /^tasks\/([^/:]+)$/.exec(relative);
        if (request.method === "GET" && getMatch) {
          const history = url.searchParams.has("historyLength")
            ? Number(url.searchParams.get("historyLength"))
            : undefined;
          const task = await requestScope.run(function* () {
            return yield* host.getTask(decodeURIComponent(getMatch[1]!), context, history);
          });
          return jsonResponse(wireTask(task, sdk03));
        }
        const cancelMatch = /^tasks\/([^/:]+):cancel$/.exec(relative);
        if (request.method === "POST" && cancelMatch) {
          const task = await requestScope.run(function* () {
            return yield* host.cancelTask(decodeURIComponent(cancelMatch[1]!), context);
          });
          return jsonResponse(wireTask(task, sdk03));
        }
        const subscribeMatch = /^tasks\/([^/:]+):subscribe$/.exec(relative);
        if (request.method === "GET" && subscribeMatch) {
          const taskId = decodeURIComponent(subscribeMatch[1]!);
          const subscription = await requestScope.run(function* () {
            yield* authorize(options, context, "task:subscribe", { taskId });
            return yield* host.subscribeTask(taskId, context);
          });
          requestScopeTransferred = true;
          return pullSseResponse(requestScope, destroyRequestScope, subscription, sdk03);
        }
        return safeErrorResponse(
          new StandardA2AHostError("task_not_found", "A2A operation is unavailable", 404),
          options.challenge,
        );
      } catch (error) {
        const safe = asHostError(error);
        options.onTelemetry?.({ type: "error", code: safe.code });
        return safeErrorResponse(safe, options.challenge);
      } finally {
        if (!requestScopeTransferred) {
          await destroyRequestScope();
        }
      }
    },
  };

  function* continueTask(
    message: ForeignA2AMessage,
    requestContext: StandardA2ARequestContext,
    contextId: string,
  ): Operation<ForeignA2ATask> {
    const taskId = message.taskId!;
    if (message.contextId && message.contextId !== contextId) {
      throw hostError("task_context_mismatch", "Task and context identities differ");
    }
    const sessionId = scopedSession(requestContext, contextId);
    const journal = yield* openJournal(journalStore, requestContext, contextId);
    const before = yield* readJournal(journal, sessionId);
    const current = yield* hostedProjection(
      before,
      taskId,
      contextId,
      options.limits.maxHistoryLength,
    );
    const digest = canonicalSnapshot(assertJson(message)).sha;
    const prior = yield* options.taskDirectory.lookupContinuation(taskId, message.messageId);
    if (prior && prior.messageDigest !== digest) {
      throw hostError("message_idempotency_conflict", "Message identity was reused");
    }
    const priorResolved =
      prior !== undefined &&
      before.some(
        (record) =>
          record.payload.type === "PullResolved" && record.payload.pullId === prior.pullId,
      );
    if (priorResolved) {
      if (!TERMINAL.has(current.status.state)) {
        yield* withRequestTrace(requestContext, function* () {
          return yield* runExisting({
            journal,
            sessionId,
            taskId,
            input: taskInput(before, taskId),
            conversation,
            drivers,
            effects,
          });
        });
      }
      return yield* hostedProjection(
        yield* readJournal(journal, sessionId),
        taskId,
        contextId,
        options.limits.maxHistoryLength,
      );
    }
    if (TERMINAL.has(current.status.state)) {
      throw hostError("task_not_modifiable", "Terminal task cannot be resumed");
    }
    const pending = pendingElicitation(before, taskId);
    if (!pending) {
      throw hostError("task_not_modifiable", "Task has no pending client input");
    }
    if (prior && prior.pullId !== pending.pullId) {
      throw hostError("message_idempotency_conflict", "Continuation pull identity changed");
    }
    yield* options.taskDirectory.bindContinuation({
      taskId,
      messageId: message.messageId,
      messageDigest: digest,
      pullId: pending.pullId,
    });
    const outcomeValue = continuationValue(message);
    const resolution = yield* journal.resolvePending({
      sessionId,
      taskId: pending.taskId,
      pullId: pending.pullId,
      audience: pending.audience,
      outcome: { status: "ok", value: { action: "accept", content: outcomeValue } },
    });
    if (resolution.status === "rejected") {
      throw new CrankError(resolution.code);
    }
    yield* withRequestTrace(requestContext, function* () {
      return yield* runExisting({
        journal,
        sessionId,
        taskId,
        input: taskInput(before, taskId),
        conversation,
        drivers,
        effects,
      });
    });
    return yield* hostedProjection(
      yield* readJournal(journal, sessionId),
      taskId,
      contextId,
      options.limits.maxHistoryLength,
    );
  }

  return Object.freeze(host);
}

function taskUpdateStream(
  resolveTask: () => Operation<ForeignA2ATask>,
): Stream<StandardA2AStreamEvent, void> {
  return resource(function* (provide) {
    let events: StandardA2AStreamEvent[] | undefined;
    let cursor = 0;
    yield* provide({
      *next(): Operation<IteratorResult<StandardA2AStreamEvent, void>> {
        if (!events) {
          const terminal = yield* resolveTask();
          events = [
            {
              kind: "task",
              task: {
                ...terminal,
                status: { state: "submitted" },
                artifacts: [],
                history: terminal.history?.slice(0, 1) ?? [],
              },
            },
            ...terminal.artifacts.map(
              (artifact): StandardA2AStreamEvent => ({
                kind: "artifact-update",
                taskId: terminal.id,
                contextId: terminal.contextId!,
                artifact,
                append: false,
                lastChunk: true,
              }),
            ),
            {
              kind: "status-update",
              taskId: terminal.id,
              contextId: terminal.contextId!,
              state: terminal.status.state,
              ...(terminal.status.message ? { message: terminal.status.message } : {}),
              // `final` closes this streaming response, not necessarily the task.
              // Interrupted tasks end the stream at a durable client-action boundary.
              final:
                TERMINAL.has(terminal.status.state) ||
                terminal.status.state === "input_required" ||
                terminal.status.state === "auth_required",
            },
          ];
        }
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

function* openAndRun(input: RuntimeInput): Operation<ProgramRunResult> {
  const attach = attachment(input);
  yield* input.journal.openTask({
    sessionId: input.sessionId,
    // ProgramRuntime's current root turn convention is "turn-0" for IDs
    // without an internal child-path slash. A2A task identity remains opaque.
    turnId: "turn-0",
    taskId: input.taskId,
    manifest: input.conversation.program.manifest,
    input: assertJson(input.input),
    executionEpoch: 1,
    attachmentId: stableProgramAttachmentId(attach),
    audience: "program-runtime",
  });
  return yield* runExisting(input);
}

interface RuntimeInput {
  readonly journal: ProgramDriverJournal;
  readonly sessionId: string;
  readonly taskId: string;
  readonly input: ChatTurnInputV1;
  readonly conversation: AgentProgramBinding;
  readonly drivers: ReturnType<typeof createProgramDriverRegistry>;
  readonly effects: ReturnType<typeof createDurableEffectRegistry>;
}

function* runExisting(input: RuntimeInput): Operation<ProgramRunResult> {
  return yield* ProgramDriverRegistryContext.with(input.drivers, function* () {
    return yield* withJournalAuthority(input.journal.authority, function* () {
      return yield* DurableEffectRegistryContext.with(input.effects, function* () {
        return yield* ProgramRouteResolverContext.with(
          function* (_program, parentRoute): Operation<Json> {
            return parentRoute;
          },
          function* () {
            return yield* ProgramRuntime.operations.run({
              attach: attachment(input),
              executeHostEffects: true,
            });
          },
        );
      });
    });
  });
}

function attachment(input: RuntimeInput) {
  const manifest = input.conversation.program.manifest;
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: assertJson(input.input),
    route: { driverKind: "program" } as Json,
    executionEpoch: 1,
  };
}

function requireConversation(definition: AgentDefinition): AgentProgramBinding {
  const conversation = definition.bindings.conversation;
  if (!conversation) {
    throw hostError("standard_profile_incompatible", "A conversation program is required");
  }
  return conversation;
}

function allPrograms(root: AgentProgramBinding): AgentProgramBinding[] {
  const found = new Map<string, AgentProgramBinding>();
  const pending = [root];
  while (pending.length > 0) {
    const binding = pending.shift()!;
    const manifest = binding.program.manifest;
    const key = `${manifest.programId}@${manifest.version}#${manifest.digest}`;
    if (found.has(key)) {
      continue;
    }
    found.set(key, binding);
    const children = (
      binding.program as DurableTool & {
        readonly childPrograms?: Readonly<Record<string, AgentProgramBinding>>;
      }
    ).childPrograms;
    if (children) {
      pending.push(...Object.values(children));
    }
  }
  return [...found.values()];
}

function acceptTurn(
  program: ChatProgramDefinition,
  message: ChatMessageV1,
  selection: Parameters<typeof acceptChatTurn>[2],
): ChatTurnInputV1 {
  try {
    return acceptChatTurn(program.contextPolicy, message, selection);
  } catch (error) {
    if (error instanceof CrankError && error.code === "chat_context_too_large") {
      throw hostError("task_input_too_large", "Accepted task input exceeds its bound");
    }
    throw error;
  }
}

function wireToChatMessage(
  message: ForeignA2AMessage,
  classification: "public" | "internal" | "confidential" | "restricted",
): ChatMessageV1 {
  return normalizeChatMessage({
    id: message.messageId,
    role: "user",
    parts: message.parts.map((part) => ({
      value:
        part.text !== undefined
          ? part.text
          : part.data !== undefined
            ? part.data
            : part.raw !== undefined
              ? { raw: part.raw, ...(part.mediaType ? { mediaType: part.mediaType } : {}) }
              : { url: part.url! },
      provenance: {
        classifications: [classification],
        sourceDigests: [canonicalIncomingMessageDigest(message)],
      },
    })),
  });
}

function canonicalIncomingMessageDigest(message: ForeignA2AMessage): string {
  return sha256(
    canonicalJson({
      messageId: message.messageId,
      role: message.role,
      parts: message.parts,
      ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
      ...(message.extensions ? { extensions: message.extensions } : {}),
    }),
  );
}

function chatToWireMessage(
  message: ChatMessageV1,
  taskId: string | undefined,
  contextId: string,
): ForeignA2AMessage {
  return {
    messageId: message.id,
    role: message.role === "assistant" ? "agent" : "user",
    ...(taskId ? { taskId } : {}),
    contextId,
    parts: message.parts.map((part) =>
      typeof part.value === "string" ? { text: part.value } : { data: part.value },
    ),
  };
}

function rootOpenings(records: readonly DurableSemanticRecord[]) {
  return records
    .filter(
      (record) => record.payload.type === "TaskOpened" && record.payload.parentTaskId === undefined,
    )
    .map((record) => record.payload)
    .filter(
      (payload): payload is Extract<typeof payload, { type: "TaskOpened" }> =>
        payload.type === "TaskOpened",
    );
}
function findRootByMessageId(records: readonly DurableSemanticRecord[], messageId: string) {
  return rootOpenings(records).find((opened) => openedTurnInput(opened).message.id === messageId);
}
type RootOpening = ReturnType<typeof rootOpenings>[number];
/**
 * Decode a journal TaskOpened input as a validated chat turn. Journal records
 * cross a persistence boundary, so shape is re-verified rather than cast.
 */
function openedTurnInput(opened: RootOpening): ChatTurnInputV1 {
  try {
    return normalizeChatTurnInput(opened.input);
  } catch (error) {
    throw hostError(
      "request_invalid",
      `Journal task input is not a valid chat turn: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
function taskInput(records: readonly DurableSemanticRecord[], taskId: string): ChatTurnInputV1 {
  const opened = rootOpenings(records).find((candidate) => candidate.taskId === taskId);
  if (!opened) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  return openedTurnInput(opened);
}
function assertIdempotentMessage(
  opened: ReturnType<typeof rootOpenings>[number],
  message: ForeignA2AMessage,
  contextId: string,
): void {
  const input = openedTurnInput(opened);
  const accepted = {
    message: input.message,
    contextId,
    referenceTaskIds: input.context.referenceTaskIds,
  };
  const retried = {
    message: wireToChatMessage(
      message,
      input.message.parts[0]?.provenance.classifications[0] ?? "public",
    ),
    contextId,
    referenceTaskIds: stableReferences(message.referenceTaskIds ?? [], DEFAULT_LIMITS),
  };
  if (canonicalJson(accepted) !== canonicalJson(retried)) {
    throw hostError("message_idempotency_conflict", "Message identity was reused with new content");
  }
}

function contextMessages(records: readonly DurableSemanticRecord[]): ChatMessageV1[] {
  const result: ChatMessageV1[] = [];
  for (const opened of rootOpenings(records)) {
    const input = openedTurnInput(opened);
    if (input.message) {
      result.push(input.message);
    }
    const close = taskClose(records, opened.taskId);
    const value = completedResult(close);
    if (value) {
      result.push(value.message);
    }
  }
  return result;
}
function referencedSummary(
  records: readonly DurableSemanticRecord[],
  taskId: string,
): ReferencedTaskSummaryV1 {
  const input = taskInput(records, taskId);
  const result = completedResult(taskClose(records, taskId));
  return { taskId, summary: result?.message ?? input.message };
}
function taskClose(records: readonly DurableSemanticRecord[], taskId: string) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const payload = records[index]!.payload;
    if (payload.type === "TaskClosed" && payload.taskId === taskId) {
      return payload;
    }
  }
  return undefined;
}
function completedResult(
  payload: DurableSemanticRecord["payload"] | undefined,
): ChatTurnResultV1 | undefined {
  if (payload?.type !== "TaskClosed" || payload.outcome.status !== "ok") {
    return undefined;
  }
  try {
    return normalizeChatTurnResult(payload.outcome.value);
  } catch {
    return undefined;
  }
}

function* custodyTaskArtifacts(
  records: readonly DurableSemanticRecord[],
  taskId: string,
  options: BoundHostOptions,
): Operation<readonly StandardA2AExternalContentBinding[]> {
  const threshold = options.externalContentThresholdBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(threshold) || threshold <= 0) {
    throw hostError("standard_profile_incompatible", "External content threshold is invalid");
  }
  const existing = yield* options.taskDirectory.contentForTask(taskId);
  const known = new Set(existing.map((binding) => `${binding.artifactId}\0${binding.partIndex}`));
  const result = completedResult(taskClose(records, taskId));
  if (!result) {
    return existing;
  }
  for (const artifact of result.artifacts) {
    for (let partIndex = 0; partIndex < artifact.parts.length; partIndex += 1) {
      const key = `${artifact.id}\0${partIndex}`;
      if (known.has(key)) {
        continue;
      }
      const value = artifact.parts[partIndex]!.value;
      const mediaType =
        typeof value === "string" ? "text/plain; charset=utf-8" : "application/json";
      const bytes = new TextEncoder().encode(
        typeof value === "string" ? value : canonicalJson(value),
      );
      if (bytes.byteLength < threshold) {
        continue;
      }
      const reference = yield* call(() =>
        putVerifiedContent(options.contentStore, {
          bytes,
          mediaType,
          association: { kind: "artifact", id: artifact.id },
          retentionClass: "task",
          retainUntil: (options.now ?? Date.now)() + options.retention.contentSeconds * 1_000,
        }),
      );
      yield* options.taskDirectory.bindContent({
        taskId,
        artifactId: artifact.id,
        partIndex,
        reference,
      });
      known.add(key);
    }
  }
  return yield* options.taskDirectory.contentForTask(taskId);
}

function externalizeTask(
  task: ForeignA2ATask,
  bindings: readonly StandardA2AExternalContentBinding[],
  interfaceUrl: string,
): ForeignA2ATask {
  if (bindings.length === 0) {
    return task;
  }
  const byPart = new Map(
    bindings.map((binding) => [`${binding.artifactId}\0${binding.partIndex}`, binding]),
  );
  return {
    ...task,
    artifacts: task.artifacts.map((artifact) => ({
      ...artifact,
      parts: artifact.parts.map((part, partIndex) => {
        const binding = byPart.get(`${artifact.artifactId}\0${partIndex}`);
        if (!binding) {
          return part;
        }
        return {
          url: `${interfaceUrl.replace(/\/$/, "")}/content/${binding.reference.digest}`,
          mediaType: binding.reference.mediaType,
          metadata: {
            digest: binding.reference.digest,
            size: binding.reference.size,
            retentionClass: binding.reference.retentionClass,
          },
        };
      }),
    })),
  };
}

function projectTask(
  records: readonly DurableSemanticRecord[],
  taskId: string,
  contextId: string,
  historyLength: number,
  historyProjection: StandardA2AHistoryProjection,
  continuations: readonly StandardA2AContinuationBinding[],
): ForeignA2ATask {
  const opened = rootOpenings(records).find((candidate) => candidate.taskId === taskId);
  if (!opened) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  const input = openedTurnInput(opened);
  const close = taskClose(records, taskId);
  const result = completedResult(close);
  const state = projectedState(records, taskId, close);
  const userMessage = chatToWireMessage(input.message, taskId, contextId);
  const agentMessage = result ? chatToWireMessage(result.message, taskId, contextId) : undefined;
  const artifacts: ForeignA2AArtifact[] = (result?.artifacts ?? []).map((artifact) => ({
    artifactId: artifact.id,
    ...(artifact.name ? { name: artifact.name } : {}),
    ...(artifact.description ? { description: artifact.description } : {}),
    parts: artifact.parts.map((part) =>
      typeof part.value === "string" ? { text: part.value } : { data: part.value },
    ),
  }));
  const failure = terminalError(close);
  const pending = pendingElicitation(records, taskId);
  const statusMessage =
    agentMessage ??
    (failure
      ? {
          messageId: `status:${taskId}`,
          role: "agent" as const,
          taskId,
          contextId,
          parts: [{ text: failure.message }],
        }
      : pending
        ? {
            messageId: `input-required:${pending.pullId}`,
            role: "agent" as const,
            taskId,
            contextId,
            parts: [
              {
                text: pending.message,
                metadata: {
                  elicitationKey: pending.key,
                  responseSchema: pending.responseSchema,
                } as Json,
              },
            ],
          }
        : undefined);
  const taskHistory = taskInteractionHistory(
    records,
    taskId,
    contextId,
    userMessage,
    agentMessage,
    continuations,
  );
  const acceptedContextHistory =
    historyProjection === "accepted-context"
      ? [
          ...input.context.messages.map((message) =>
            chatToWireMessage(message, undefined, contextId),
          ),
          ...input.context.referencedTasks.map((referenced) =>
            chatToWireMessage(referenced.summary, undefined, contextId),
          ),
        ]
      : [];
  const historyCandidates = deduplicateWireMessages([...acceptedContextHistory, ...taskHistory]);
  const history = historyLength === 0 ? [] : historyCandidates.slice(-historyLength);
  return Object.freeze({
    id: taskId,
    contextId,
    status: Object.freeze({ state, ...(statusMessage ? { message: statusMessage } : {}) }),
    artifacts,
    history,
    metadata: assertJson(
      Object.freeze({
        referenceTaskIds: Object.freeze([...(input.context?.referenceTaskIds ?? [])]),
        frontier: input.context?.frontier ?? "0",
      }),
    ),
  });
}

function taskInteractionHistory(
  records: readonly DurableSemanticRecord[],
  rootTaskId: string,
  contextId: string,
  userMessage: ForeignA2AMessage,
  agentMessage: ForeignA2AMessage | undefined,
  continuations: readonly StandardA2AContinuationBinding[],
): ForeignA2AMessage[] {
  const taskIds = descendantTaskIds(records, rootTaskId);
  const continuationByPull = new Map(continuations.map((binding) => [binding.pullId, binding]));
  const history: ForeignA2AMessage[] = [userMessage];
  for (const record of records) {
    const payload = record.payload;
    if (
      payload.type !== "PullRequested" ||
      payload.descriptor.kind !== "elicit" ||
      !taskIds.has(payload.taskId)
    ) {
      continue;
    }
    history.push({
      messageId: `input-required:${payload.pullId}`,
      role: "agent",
      taskId: rootTaskId,
      contextId,
      parts: [
        {
          text: payload.descriptor.message,
          metadata: {
            elicitationKey: payload.descriptor.key,
            responseSchema: payload.descriptor.response.inputProjection,
          },
        },
      ],
    });
    const resolved = records.find(
      (candidate) =>
        candidate.payload.type === "PullResolved" &&
        candidate.payload.taskId === payload.taskId &&
        candidate.payload.pullId === payload.pullId,
    )?.payload;
    const continuation = continuationByPull.get(payload.pullId);
    if (resolved?.type === "PullResolved" && resolved.outcome.status === "ok" && continuation) {
      const value = resolved.outcome.value;
      const content =
        value && typeof value === "object" && !Array.isArray(value) && value["action"] === "accept"
          ? (value["content"] ?? null)
          : value;
      history.push({
        messageId: continuation.messageId,
        role: "user",
        taskId: rootTaskId,
        contextId,
        parts: [typeof content === "string" ? { text: content } : { data: content }],
      });
    }
  }
  if (agentMessage) {
    history.push(agentMessage);
  }
  return history;
}
function deduplicateWireMessages(messages: readonly ForeignA2AMessage[]): ForeignA2AMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.messageId)) {
      return false;
    }
    seen.add(message.messageId);
    return true;
  });
}

function projectedState(
  records: readonly DurableSemanticRecord[],
  rootTaskId: string,
  close: DurableSemanticRecord["payload"] | undefined,
): ForeignA2ANormalizedState {
  if (close?.type === "TaskClosed") {
    if (close.outcome.status === "ok") {
      return "completed";
    }
    if (close.outcome.status === "cancelled") {
      return "canceled";
    }
    return "failed";
  }
  const taskIds = descendantTaskIds(records, rootTaskId);
  let unresolved: DurableSemanticRecord | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const candidateRecord = records[index]!;
    const payload = candidateRecord.payload;
    if (payload.type !== "PullRequested" || !taskIds.has(payload.taskId)) {
      continue;
    }
    const resolved = records.some(
      (candidate) =>
        candidate.payload.type === "PullResolved" &&
        candidate.payload.taskId === payload.taskId &&
        candidate.payload.pullId === payload.pullId,
    );
    if (!resolved) {
      unresolved = candidateRecord;
      break;
    }
  }
  if (unresolved?.payload.type === "PullRequested") {
    if (unresolved.payload.descriptor.kind === "elicit") {
      return "input_required";
    }
    if (
      unresolved.payload.descriptor.kind === "effect" &&
      unresolved.payload.descriptor.resolver.route === "secondary-authorization"
    ) {
      return "auth_required";
    }
  }
  return "working";
}
function descendantTaskIds(
  records: readonly DurableSemanticRecord[],
  rootTaskId: string,
): Set<string> {
  const ids = new Set([rootTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const opened of records) {
      if (
        opened.payload.type === "TaskOpened" &&
        opened.payload.parentTaskId &&
        ids.has(opened.payload.parentTaskId) &&
        !ids.has(opened.payload.taskId)
      ) {
        ids.add(opened.payload.taskId);
        changed = true;
      }
    }
  }
  return ids;
}
function terminalError(payload: DurableSemanticRecord["payload"] | undefined) {
  if (payload?.type !== "TaskClosed" || payload.outcome.status !== "error") {
    return undefined;
  }
  return safeApplicationError(payload.outcome.error);
}
function safeApplicationError(error: SerializedApplicationError) {
  return { code: error.code || "application_error", message: "Agent task failed" };
}

function pendingElicitation(records: readonly DurableSemanticRecord[], rootTaskId: string) {
  const taskIds = descendantTaskIds(records, rootTaskId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    const payload = record.payload;
    if (
      payload.type === "PullRequested" &&
      taskIds.has(payload.taskId) &&
      payload.descriptor.kind === "elicit" &&
      !records.some(
        (candidate) =>
          candidate.payload.type === "PullResolved" &&
          candidate.payload.taskId === payload.taskId &&
          candidate.payload.pullId === payload.pullId,
      )
    ) {
      return {
        taskId: payload.taskId,
        pullId: payload.pullId,
        audience: `user:${payload.descriptor.key}`,
        key: payload.descriptor.key,
        message: payload.descriptor.message,
        responseSchema: payload.descriptor.response.inputProjection,
      };
    }
  }
  return undefined;
}
function continuationValue(message: ForeignA2AMessage): Json {
  if (message.parts.length !== 1) {
    throw hostError("task_not_modifiable", "Continuation must contain exactly one response part");
  }
  const part = message.parts[0]!;
  if (part.data !== undefined) {
    return part.data;
  }
  if (part.text !== undefined) {
    return part.text;
  }
  if (part.raw !== undefined) {
    return part.raw;
  }
  return part.url!;
}

function resolveContextId(
  supplied: string | undefined,
  options: CreateStandardA2AHostOptions,
): string {
  if (supplied) {
    if (!validPublicId(supplied)) {
      throw hostError("context_not_found", "Context identity is invalid");
    }
    return supplied;
  }
  const generated = options.generateContextId?.() ?? `ctx_${randomUUID().replaceAll("-", "")}`;
  if (!validPublicId(generated)) {
    throw hostError("standard_profile_incompatible", "Generated context identity is invalid");
  }
  return generated;
}
function* lookupAuthorizedTask(
  directory: StandardA2ATaskDirectory,
  taskId: string,
  context: StandardA2ARequestContext,
): Operation<StandardA2ATaskDirectoryEntry> {
  if (!validPublicId(taskId)) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  const entry = yield* directory.lookup(taskId);
  if (!entry || entry.ownerScope !== requestOwnerScope(context)) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  return entry;
}
function* withRequestTrace<T>(
  context: StandardA2ARequestContext,
  operation: () => Operation<T>,
): Operation<T> {
  if (!context.traceparent) {
    return yield* operation();
  }
  return yield* StandardA2ATraceContext.with(
    {
      traceparent: context.traceparent,
      ...(context.tracestate ? { tracestate: context.tracestate } : {}),
    },
    operation,
  );
}
function requestOwnerScope(context: StandardA2ARequestContext): string {
  return sha256(
    canonicalJson({
      principalId: context.principalId,
      tenantId: context.tenantId ?? null,
    }),
  );
}
function safeNonce(value: string): string {
  const safe = value.replaceAll("-", "");
  if (!/^[A-Za-z0-9_]{8,128}$/.test(safe)) {
    throw hostError("standard_profile_incompatible", "Generated task nonce is invalid");
  }
  return safe;
}
function validPublicId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes("/") &&
    !Array.from(value).some((character) => character.charCodeAt(0) <= 0x1f)
  );
}
function scopedSession(context: StandardA2ARequestContext, contextId: string): string {
  return `a2a_${sha256(
    canonicalJson({
      principalId: context.principalId,
      tenantId: context.tenantId ?? null,
      contextId,
    }),
  ).slice(0, 48)}`;
}
function* openJournal(
  store: ProgramDriverJournalStore,
  context: StandardA2ARequestContext,
  contextId: string,
): Operation<ProgramDriverJournal> {
  return yield* store.open(scopedSession(context, contextId));
}
function* readJournal(
  journal: ProgramDriverJournal,
  sessionId: string,
): Operation<DurableSemanticRecord[]> {
  return yield* journal.readJournal(sessionId);
}

function stableReferences(values: readonly string[], limits: StandardA2AHostLimits): string[] {
  if (values.length > limits.maxReferences) {
    throw hostError("task_reference_invalid", "Task reference count exceeds its bound");
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!validPublicId(value)) {
      throw hostError("task_reference_invalid", "Task reference is invalid");
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
function normalizeHistoryLength(value: number | undefined, limits: StandardA2AHostLimits): number {
  if (value === undefined) {
    return limits.maxHistoryLength;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > limits.maxHistoryLength) {
    throw hostError("task_not_found", "History length is invalid");
  }
  return value;
}

function* authenticate(
  options: CreateStandardA2AHostOptions,
  request: Request,
): Operation<StandardA2ARequestContext> {
  const authenticated = options.authenticate ? yield* options.authenticate(request) : undefined;
  if (authenticated) {
    return validateRequestContext(authenticated);
  }
  if (options.allowAnonymousDevelopment) {
    return { principalId: "anonymous-development" };
  }
  throw hostError("authentication_failed", "Authentication is required");
}
function validateRequestContext(value: StandardA2ARequestContext): StandardA2ARequestContext {
  if (!value.principalId || value.principalId.length > 512) {
    throw hostError("authentication_failed", "Authentication is invalid");
  }
  const traceparent = value.traceparent?.toLowerCase();
  const validTrace =
    traceparent && /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)
      ? traceparent
      : undefined;
  return Object.freeze({
    principalId: value.principalId,
    ...(value.tenantId ? { tenantId: value.tenantId } : {}),
    ...(value.clientId ? { clientId: value.clientId } : {}),
    ...(validTrace ? { traceparent: validTrace } : {}),
    ...(validTrace && value.tracestate ? { tracestate: value.tracestate.slice(0, 512) } : {}),
  });
}
function* authorize(
  options: CreateStandardA2AHostOptions,
  context: StandardA2ARequestContext,
  action: StandardA2AAuthorizationAction,
  boundary: { readonly contextId?: string; readonly taskId?: string },
): Operation<void> {
  if (options.authorize && !(yield* options.authorize({ context, action, ...boundary }))) {
    throw hostError("authorization_denied", "The requested operation is not authorized");
  }
  options.onTelemetry?.({ type: "request", action, ...boundary });
}

function validateTransport(deployment: PublicAgentDeployment): void {
  const url = new URL(deployment.interfaceUrl);
  if (url.protocol === "https:") {
    return;
  }
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (
    url.protocol === "http:" &&
    ((loopback && deployment.insecureLoopbackDevelopment === true) ||
      deployment.unsafeAllowNonLoopbackHttp === true)
  ) {
    return;
  }
  throw hostError(
    "insecure_production_transport",
    "Standard production serving requires an HTTPS interface",
  );
}
function relativeInterfacePath(interfaceUrl: string, requestUrl: URL): string {
  const base = new URL(interfaceUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  if (requestUrl.pathname === prefix) {
    return "";
  }
  if (!requestUrl.pathname.startsWith(`${prefix}/`)) {
    return "__unmatched__";
  }
  const relative = requestUrl.pathname.slice(prefix.length + 1);
  return relative.startsWith("v1/") ? relative.slice(3) : relative;
}
function isSdk03Path(interfaceUrl: string, requestUrl: URL): boolean {
  const prefix = new URL(interfaceUrl).pathname.replace(/\/$/, "");
  return requestUrl.pathname.startsWith(`${prefix}/v1/`);
}
async function boundedBody(request: Request, maxBytes: number): Promise<Json> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw hostError("task_input_too_large", "A2A request body exceeds its bound");
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Json;
  } catch {
    throw hostError("request_invalid", "A2A request body is invalid JSON");
  }
}
function parseIncomingMessage(value: unknown, sdk03: boolean): ForeignA2AMessage {
  if (!sdk03) {
    return parseForeignA2AMessage(value);
  }
  const message = bodyRecord(value as Json);
  const { content, ...withoutContent } = message;
  return parseForeignA2AMessage({ ...withoutContent, parts: content });
}
function bodyRecord(value: Json): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw hostError("task_input_too_large", "A2A request body must be an object");
  }
  return value;
}
function jsonResponse(value: Json, status = 200, headers?: HeadersInit): Response {
  return new Response(canonicalJson(value), {
    status,
    headers: { "content-type": "application/a2a+json", ...headers },
  });
}
function pullSseResponse(
  scope: Scope,
  destroyScope: () => Promise<void>,
  subscription: Subscription<StandardA2AStreamEvent, void>,
  sdk03: boolean,
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const cleanup = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await destroyScope();
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      try {
        const result = await scope.run(function* () {
          return yield* subscription.next();
        });
        if (result.done) {
          controller.close();
          await cleanup();
          return;
        }
        controller.enqueue(
          encoder.encode(
            `event: ${result.value.kind}\ndata: ${canonicalJson(wireStreamEvent(result.value, sdk03))}\n\n`,
          ),
        );
      } catch (error) {
        controller.error(error);
        await cleanup();
      }
    },
    async cancel() {
      await cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
function wireStreamEvent(event: StandardA2AStreamEvent, sdk03: boolean): Json {
  if (event.kind === "task") {
    return { task: wireTask(event.task, sdk03) };
  }
  if (event.kind === "artifact-update") {
    return {
      artifactUpdate: {
        taskId: event.taskId,
        contextId: event.contextId,
        artifact: event.artifact,
        append: event.append,
        lastChunk: event.lastChunk,
      },
    };
  }
  return {
    statusUpdate: {
      taskId: event.taskId,
      contextId: event.contextId,
      status: {
        state: wireState(event.state),
        ...(event.message ? { message: wireMessage(event.message, sdk03) } : {}),
      },
      final: event.final,
    },
  };
}
function wireState(state: ForeignA2ANormalizedState): string {
  return {
    submitted: "TASK_STATE_SUBMITTED",
    working: "TASK_STATE_WORKING",
    input_required: "TASK_STATE_INPUT_REQUIRED",
    auth_required: "TASK_STATE_AUTH_REQUIRED",
    completed: "TASK_STATE_COMPLETED",
    failed: "TASK_STATE_FAILED",
    canceled: "TASK_STATE_CANCELED",
    rejected: "TASK_STATE_REJECTED",
  }[state];
}
function wireMessage(value: ForeignA2AMessage, sdk03: boolean): Json {
  const projection = {
    ...value,
    role: value.role === "user" ? "ROLE_USER" : "ROLE_AGENT",
  };
  if (!sdk03) {
    return projection;
  }
  const { parts, ...withoutParts } = projection;
  return { ...withoutParts, content: parts };
}
function wireTask(task: ForeignA2ATask, sdk03 = false): Json {
  const state = wireState(task.status.state);
  return assertJson({
    ...task,
    status: {
      ...task.status,
      state,
      ...(task.status.message ? { message: wireMessage(task.status.message, sdk03) } : {}),
    },
    ...(task.history
      ? { history: task.history.map((message) => wireMessage(message, sdk03)) }
      : {}),
  });
}
function safeErrorResponse(error: StandardA2AHostError, challenge = "Bearer"): Response {
  const headers: Record<string, string> = {};
  if (error.httpStatus === 401) {
    headers["www-authenticate"] = challenge;
  }
  return jsonResponse(
    { error: { code: error.code, message: error.message } },
    error.httpStatus,
    headers,
  );
}
function asHostError(error: unknown): StandardA2AHostError {
  if (error instanceof StandardA2AHostError) {
    return error;
  }
  if (error instanceof CrankError) {
    if (error.code === "model_egress_forbidden") {
      return hostError("model_egress_forbidden", "Model route rejected the selected data");
    }
    if (error.code === "schema_validation_failed" || error.code === "payload_too_large") {
      return hostError("task_input_too_large", "A2A input failed validation");
    }
  }
  return new StandardA2AHostError(
    "standard_profile_incompatible",
    "The agent host could not complete the operation",
    500,
  );
}
function hostError(code: StandardA2AHostErrorCode, message: string): StandardA2AHostError {
  return new StandardA2AHostError(code, message);
}
function hostStatus(code: StandardA2AHostErrorCode): number {
  if (code === "authentication_failed") {
    return 401;
  }
  if (code === "authorization_denied") {
    return 403;
  }
  if (
    ["context_not_found", "task_not_found", "content_unavailable", "content_expired"].includes(code)
  ) {
    return 404;
  }
  if (code === "message_idempotency_conflict" || code === "content_digest_conflict") {
    return 409;
  }
  if (code === "insecure_production_transport" || code === "standard_profile_incompatible") {
    return 503;
  }
  return 400;
}
async function checkTaskDirectory(directory: StandardA2ATaskDirectory): Promise<void> {
  if (!directory.check) {
    return;
  }
  const [scope, destroyScope] = createScope();
  try {
    await scope.run(function* () {
      yield* directory.check!();
    });
  } finally {
    await destroyScope();
  }
}

function normalizeRetention(
  input: Partial<StandardA2ARetentionPolicy> | undefined,
): StandardA2ARetentionPolicy {
  const value = { ...DEFAULT_RETENTION, ...input };
  for (const amount of Object.values(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw hostError("standard_profile_incompatible", "Retention values must be positive seconds");
    }
  }
  if (value.contentSeconds < value.taskSeconds) {
    throw hostError(
      "standard_profile_incompatible",
      "Content retention cannot be shorter than task retention",
    );
  }
  if (value.messageIdempotencySeconds > value.taskSeconds) {
    throw hostError(
      "standard_profile_incompatible",
      "Task retention must cover message reconciliation",
    );
  }
  return Object.freeze(value);
}
function normalizeLimits(input: Partial<StandardA2AHostLimits> | undefined): StandardA2AHostLimits {
  const value = { ...DEFAULT_LIMITS, ...input };
  for (const amount of Object.values(value)) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw hostError("standard_profile_incompatible", "Host limits must be positive integers");
    }
  }
  return Object.freeze(value);
}
function* withLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Operation<T>,
): Operation<T> {
  const release = yield* call(() => acquireLock(locks, key));
  try {
    return yield* operation();
  } finally {
    release();
  }
}
function acquireLock(locks: Map<string, Promise<void>>, key: string): Promise<() => void> {
  const previous = locks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  return previous.then(() => () => {
    releaseCurrent();
    if (locks.get(key) === queued) {
      locks.delete(key);
    }
  });
}
function descriptorTarget(descriptor: DurableOperationDescriptor): string {
  if (descriptor.kind === "effect") {
    return descriptor.name;
  }
  if (descriptor.kind === "invoke") {
    return descriptor.child.id;
  }
  if (descriptor.kind === "elicit" || descriptor.kind === "wait") {
    return descriptor.key;
  }
  return descriptor.kind;
}
function payloadTaskId(payload: DurableSemanticRecord["payload"]): string | undefined {
  return "taskId" in payload ? payload.taskId : undefined;
}
