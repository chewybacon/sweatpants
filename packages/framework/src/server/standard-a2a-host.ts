import { randomUUID } from "node:crypto";
import { run, type Operation } from "effection";
import {
  CrankError,
  DurableEffectRegistryContext,
  JournalAuthorityContext,
  ProgramDriverRegistryContext,
  ProgramRouteResolverContext,
  ProgramRuntime,
  canonicalJson,
  canonicalSnapshot,
  createCapabilityKeyring,
  createDurableEffectRegistry,
  createDurableToolRegistry,
  createLocalGeneratorDriver,
  createProgramDriverRegistry,
  sha256,
  stableProgramAttachmentId,
  type DurableEffectRegistration,
  type DurableSemanticRecord,
  type DurableTool,
  type Json,
  type ProgramRunResult,
  type SerializedApplicationError,
} from "@sweatpants/session-contract";
import {
  createInMemoryImmutableContentStore,
  parseForeignA2AMessage,
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

export interface StandardA2AHostBinding {
  readonly definition: AgentDefinition;
  readonly card: Json;
  readonly deployment: PublicAgentDeployment;
  readonly handlers: readonly DurableEffectRegistration[];
}

export interface StandardA2AHostPort {
  readonly kind: "standard-a2a-task-host.v1";
  readonly services: Json;
  bind?(binding: StandardA2AHostBinding): BoundStandardA2AHost;
  check?(): Promise<void>;
}

export interface BoundStandardA2AHost extends StandardA2AHostPort {
  readonly readiness: boolean;
  readonly card: Json;
  handle(request: Request, context?: StandardA2ARequestContext): Promise<Response>;
  sendMessage(
    message: ForeignA2AMessage,
    context: StandardA2ARequestContext,
  ): Promise<ForeignA2ATask>;
  getTask(
    taskId: string,
    context: StandardA2ARequestContext,
    historyLength?: number,
  ): Promise<ForeignA2ATask>;
  cancelTask(taskId: string, context: StandardA2ARequestContext): Promise<ForeignA2ATask>;
  evidence(contextId: string, context: StandardA2ARequestContext): Promise<StandardA2AEvidence>;
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
}

export interface CreateStandardA2AHostOptions {
  readonly journalStore?: ProgramDriverJournalStore;
  readonly contentStore?: ImmutableContentStore;
  readonly retention?: Partial<StandardA2ARetentionPolicy>;
  readonly limits?: Partial<StandardA2AHostLimits>;
  readonly now?: () => number;
  readonly generateContextId?: () => string;
  readonly generateTaskNonce?: () => string;
  readonly allowClientContextIds?: boolean;
  readonly allowAnonymousDevelopment?: boolean;
  readonly authenticate?: (
    request: Request,
  ) => Promise<StandardA2ARequestContext | undefined> | StandardA2ARequestContext | undefined;
  readonly authorize?: (input: {
    readonly context: StandardA2ARequestContext;
    readonly action: StandardA2AAuthorizationAction;
    readonly contextId?: string;
    readonly taskId?: string;
  }) => Promise<boolean> | boolean;
  readonly challenge?: string;
  readonly inputClassification?: "public" | "internal" | "confidential" | "restricted";
  readonly onTelemetry?: (event: {
    readonly type: "request" | "state" | "error";
    readonly action?: StandardA2AAuthorizationAction;
    readonly taskId?: string;
    readonly contextId?: string;
    readonly state?: ForeignA2ANormalizedState;
    readonly code?: string;
  }) => void;
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
  return Object.freeze({
    kind: "standard-a2a-task-host.v1" as const,
    services: Object.freeze({
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
    }) as unknown as Json,
    bind(binding: StandardA2AHostBinding) {
      return bindStandardHost(binding, {
        ...options,
        retention,
        limits,
        contentStore,
      });
    },
    async check() {
      await contentStore.check?.();
    },
  });
}

function bindStandardHost(
  binding: StandardA2AHostBinding,
  options: CreateStandardA2AHostOptions & {
    retention: StandardA2ARetentionPolicy;
    limits: StandardA2AHostLimits;
    contentStore: ImmutableContentStore;
  },
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
  const drivers = createProgramDriverRegistry([
    ["generator", createLocalGeneratorDriver(registry)],
  ]);
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
  const continuationIds = new Map<string, string>();

  const host: BoundStandardA2AHost = {
    kind: "standard-a2a-task-host.v1",
    services: Object.freeze({
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
    }) as unknown as Json,
    readiness: true,
    card: binding.card,
    bind() {
      return host;
    },
    async check() {
      await options.contentStore.check?.();
    },
    async sendMessage(messageValue, requestContext) {
      const message = parseForeignA2AMessage(messageValue);
      if (message.role !== "user") {
        throw hostError("standard_profile_incompatible", "Only user messages may be sent");
      }
      const targetContext = message.taskId ? taskContextId(message.taskId) : message.contextId;
      await authorize(options, requestContext, message.taskId ? "task:continue" : "message:send", {
        ...(targetContext ? { contextId: targetContext } : {}),
        ...(message.taskId ? { taskId: message.taskId } : {}),
      });
      if (message.taskId) {
        return withLock(locks, scopedSession(requestContext, targetContext!), async () =>
          continueTask(message, requestContext),
        );
      }
      const contextId = await resolveContextId(message.contextId, options);
      return withLock(locks, scopedSession(requestContext, contextId), async () => {
        const journal = await openJournal(journalStore, requestContext, contextId);
        const before = await readJournal(journal, scopedSession(requestContext, contextId));
        if (message.contextId && before.length === 0 && !options.allowClientContextIds) {
          throw hostError("context_not_found", "Client context identities are not accepted");
        }
        const existing = findRootByMessageId(before, message.messageId);
        if (existing) {
          assertIdempotentMessage(existing, message, contextId);
          return projectTask(before, existing.taskId, options.limits.maxHistoryLength);
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
        const taskId = `${contextId}.${safeNonce(options.generateTaskNonce?.() ?? randomUUID())}`;
        await openAndRun({
          journal,
          sessionId: scopedSession(requestContext, contextId),
          taskId,
          input,
          conversation,
          drivers,
          effects,
        });
        const after = await readJournal(journal, scopedSession(requestContext, contextId));
        const task = projectTask(after, taskId, options.limits.maxHistoryLength);
        options.onTelemetry?.({
          type: "state",
          contextId,
          taskId,
          state: task.status.state,
        });
        return task;
      });
    },
    async getTask(taskId, requestContext, historyLength) {
      const contextId = taskContextId(taskId);
      await authorize(options, requestContext, "task:read", { contextId, taskId });
      const journal = await openJournal(journalStore, requestContext, contextId);
      const records = await readJournal(journal, scopedSession(requestContext, contextId));
      return projectTask(records, taskId, normalizeHistoryLength(historyLength, options.limits));
    },
    async cancelTask(taskId, requestContext) {
      const contextId = taskContextId(taskId);
      await authorize(options, requestContext, "task:cancel", { contextId, taskId });
      const sessionId = scopedSession(requestContext, contextId);
      const journal = await openJournal(journalStore, requestContext, contextId);
      const before = await readJournal(journal, sessionId);
      const current = projectTask(before, taskId, options.limits.maxHistoryLength);
      if (TERMINAL.has(current.status.state)) {
        if (current.status.state === "canceled") {
          return current;
        }
        throw hostError("task_not_modifiable", "Terminal task cannot be canceled");
      }
      // Cancellation deliberately bypasses the per-context new-turn lock: the
      // journal authority records the exact-task frontier first and signals a
      // live local effect without waiting for the request that owns it.
      await run(function* () {
        yield* journal.requestCancellation(sessionId, taskId, "A2A cancellation requested");
      });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const after = await readJournal(journal, sessionId);
        const projected = projectTask(after, taskId, options.limits.maxHistoryLength);
        if (TERMINAL.has(projected.status.state)) {
          return projected;
        }
        await delay(5);
      }
      // Parked work has no live executor to observe the cancellation. Drive its
      // exact accepted input through recovery after the live grace interval.
      await runExisting({
        journal,
        sessionId,
        taskId,
        input: taskInput(before, taskId),
        conversation,
        drivers,
        effects,
      });
      return projectTask(
        await readJournal(journal, sessionId),
        taskId,
        options.limits.maxHistoryLength,
      );
    },
    async evidence(contextId, requestContext) {
      await authorize(options, requestContext, "task:read", { contextId });
      const sessionId = scopedSession(requestContext, contextId);
      const journal = await openJournal(journalStore, requestContext, contextId);
      const records = await readJournal(journal, sessionId);
      const tasks = rootOpenings(records).map((opened) => {
        const projected = projectTask(records, opened.taskId, 0);
        const input = opened.input as unknown as ChatTurnInputV1;
        return Object.freeze({
          taskId: opened.taskId,
          state: projected.status.state,
          referenceTaskIds: Object.freeze([...(input.context?.referenceTaskIds ?? [])]),
        });
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
      });
    },
    async handle(request, suppliedContext) {
      try {
        const url = new URL(request.url);
        const cardPath = url.pathname.endsWith("/.well-known/agent-card.json");
        const context = suppliedContext ?? (await authenticate(options, request));
        if (cardPath) {
          await authorize(options, context, "card:read", {});
          return jsonResponse(binding.card);
        }
        const relative = relativeInterfacePath(binding.deployment.interfaceUrl, url);
        const sdk03 = isSdk03Path(binding.deployment.interfaceUrl, url);
        options.onTelemetry?.({ type: "request" });
        if (request.method === "POST" && relative === "message:send") {
          const body = await boundedBody(request, options.limits.maxRequestBytes);
          const bodyValue = bodyRecord(body);
          const message = bodyValue["message"] ?? bodyValue["request"];
          const task = await host.sendMessage(parseIncomingMessage(message, sdk03), context);
          return jsonResponse({ task: wireTask(task, sdk03) });
        }
        if (request.method === "POST" && relative === "message:stream") {
          const body = await boundedBody(request, options.limits.maxRequestBytes);
          const bodyValue = bodyRecord(body);
          const task = await host.sendMessage(
            parseIncomingMessage(bodyValue["message"] ?? bodyValue["request"], sdk03),
            context,
          );
          return sseResponse(task, sdk03);
        }
        const getMatch = /^tasks\/([^/:]+)$/.exec(relative);
        if (request.method === "GET" && getMatch) {
          const history = url.searchParams.has("historyLength")
            ? Number(url.searchParams.get("historyLength"))
            : undefined;
          return jsonResponse(
            wireTask(await host.getTask(decodeURIComponent(getMatch[1]!), context, history), sdk03),
          );
        }
        const cancelMatch = /^tasks\/([^/:]+):cancel$/.exec(relative);
        if (request.method === "POST" && cancelMatch) {
          return jsonResponse(
            wireTask(await host.cancelTask(decodeURIComponent(cancelMatch[1]!), context), sdk03),
          );
        }
        const subscribeMatch = /^tasks\/([^/:]+):subscribe$/.exec(relative);
        if (request.method === "GET" && subscribeMatch) {
          await authorize(options, context, "task:subscribe", {
            taskId: decodeURIComponent(subscribeMatch[1]!),
          });
          return sseResponse(
            await host.getTask(decodeURIComponent(subscribeMatch[1]!), context),
            sdk03,
          );
        }
        return safeErrorResponse(
          new StandardA2AHostError("task_not_found", "A2A operation is unavailable", 404),
          options.challenge,
        );
      } catch (error) {
        const safe = asHostError(error);
        options.onTelemetry?.({ type: "error", code: safe.code });
        return safeErrorResponse(safe, options.challenge);
      }
    },
  };

  async function continueTask(
    message: ForeignA2AMessage,
    requestContext: StandardA2ARequestContext,
  ): Promise<ForeignA2ATask> {
    const taskId = message.taskId!;
    const contextId = taskContextId(taskId);
    if (message.contextId && message.contextId !== contextId) {
      throw hostError("task_context_mismatch", "Task and context identities differ");
    }
    const sessionId = scopedSession(requestContext, contextId);
    const journal = await openJournal(journalStore, requestContext, contextId);
    const before = await readJournal(journal, sessionId);
    const current = projectTask(before, taskId, options.limits.maxHistoryLength);
    const continuationKey = `${sessionId}\0${taskId}\0${message.messageId}`;
    const digest = canonicalSnapshot(message as unknown as Json).sha;
    const prior = continuationIds.get(continuationKey);
    if (prior) {
      if (prior !== digest) {
        throw hostError("message_idempotency_conflict", "Message identity was reused");
      }
      return current;
    }
    if (TERMINAL.has(current.status.state)) {
      throw hostError("task_not_modifiable", "Terminal task cannot be resumed");
    }
    const pending = pendingElicitation(before, taskId);
    if (!pending) {
      throw hostError("task_not_modifiable", "Task has no pending client input");
    }
    const outcomeValue = continuationValue(message);
    await run(function* () {
      const result = yield* journal.resolvePending({
        sessionId,
        taskId: pending.taskId,
        pullId: pending.pullId,
        audience: pending.audience,
        outcome: { status: "ok", value: outcomeValue },
      });
      if (result.status === "rejected") {
        throw new CrankError(result.code);
      }
    });
    continuationIds.set(continuationKey, digest);
    await runExisting({
      journal,
      sessionId,
      taskId,
      input: taskInput(before, taskId),
      conversation,
      drivers,
      effects,
    });
    return projectTask(
      await readJournal(journal, sessionId),
      taskId,
      options.limits.maxHistoryLength,
    );
  }

  return Object.freeze(host);
}

async function openAndRun(input: RuntimeInput): Promise<ProgramRunResult> {
  const attach = attachment(input);
  await run(function* () {
    yield* input.journal.openTask({
      sessionId: input.sessionId,
      // ProgramRuntime's current root turn convention is "turn-0" for IDs
      // without an internal child-path slash. A2A task identity remains opaque.
      turnId: "turn-0",
      taskId: input.taskId,
      manifest: input.conversation.program.manifest,
      input: input.input as unknown as Json,
      executionEpoch: 1,
      attachmentId: stableProgramAttachmentId(attach),
      audience: "program-runtime",
    });
  });
  return runExisting(input);
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

async function runExisting(input: RuntimeInput): Promise<ProgramRunResult> {
  return run(function* () {
    return yield* ProgramDriverRegistryContext.with(input.drivers, function* () {
      return yield* JournalAuthorityContext.with(input.journal.authority, function* () {
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
  });
}

function attachment(input: RuntimeInput) {
  const manifest = input.conversation.program.manifest;
  return {
    sessionId: input.sessionId,
    taskId: input.taskId,
    program: { id: manifest.programId, version: manifest.version, digest: manifest.digest },
    input: input.input as unknown as Json,
    route: { driverKind: "generator" } as Json,
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
  taskId: string,
  contextId: string,
): ForeignA2AMessage {
  return {
    messageId: message.id,
    role: message.role === "assistant" ? "agent" : "user",
    taskId,
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
  return rootOpenings(records).find((opened) => {
    const input = opened.input as unknown as Partial<ChatTurnInputV1>;
    return input.message?.id === messageId;
  });
}
function taskInput(records: readonly DurableSemanticRecord[], taskId: string): ChatTurnInputV1 {
  const opened = rootOpenings(records).find((candidate) => candidate.taskId === taskId);
  if (!opened) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  return opened.input as unknown as ChatTurnInputV1;
}
function assertIdempotentMessage(
  opened: ReturnType<typeof rootOpenings>[number],
  message: ForeignA2AMessage,
  contextId: string,
): void {
  const input = opened.input as unknown as ChatTurnInputV1;
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
    const input = opened.input as unknown as Partial<ChatTurnInputV1>;
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

function projectTask(
  records: readonly DurableSemanticRecord[],
  taskId: string,
  historyLength: number,
): ForeignA2ATask {
  const opened = rootOpenings(records).find((candidate) => candidate.taskId === taskId);
  if (!opened) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  const contextId = taskContextId(taskId);
  const input = opened.input as unknown as ChatTurnInputV1;
  const close = taskClose(records, taskId);
  const result = completedResult(close);
  const state = projectedState(records, taskId, close);
  const userMessage = chatToWireMessage(input.message, taskId, contextId);
  const agentMessage = result ? chatToWireMessage(result.message, taskId, contextId) : undefined;
  const allHistory = [userMessage, ...(agentMessage ? [agentMessage] : [])];
  const history = historyLength === 0 ? [] : allHistory.slice(-historyLength);
  const artifacts: ForeignA2AArtifact[] = (result?.artifacts ?? []).map((artifact) => ({
    artifactId: artifact.id,
    ...(artifact.name ? { name: artifact.name } : {}),
    ...(artifact.description ? { description: artifact.description } : {}),
    parts: artifact.parts.map((part) =>
      typeof part.value === "string" ? { text: part.value } : { data: part.value },
    ),
  }));
  const failure = terminalError(close);
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
      : undefined);
  return Object.freeze({
    id: taskId,
    contextId,
    status: Object.freeze({ state, ...(statusMessage ? { message: statusMessage } : {}) }),
    artifacts,
    history,
    metadata: Object.freeze({
      referenceTaskIds: Object.freeze([...(input.context?.referenceTaskIds ?? [])]),
      frontier: input.context?.frontier ?? "0",
    }) as unknown as Json,
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
        audience: "program-runtime",
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

async function resolveContextId(
  supplied: string | undefined,
  options: CreateStandardA2AHostOptions,
): Promise<string> {
  if (supplied) {
    if (!validPublicId(supplied)) {
      throw hostError("context_not_found", "Context identity is invalid");
    }
    return supplied;
  }
  const generated = options.generateContextId?.() ?? `ctx_${randomUUID().replaceAll("-", "")}`;
  if (!validPublicId(generated) || generated.includes(".")) {
    throw hostError("standard_profile_incompatible", "Generated context identity is invalid");
  }
  return generated;
}
function taskContextId(taskId: string): string {
  if (!validPublicId(taskId)) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  const split = taskId.lastIndexOf(".");
  if (split <= 0) {
    throw hostError("task_not_found", "Task is unavailable");
  }
  return taskId.slice(0, split);
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
async function openJournal(
  store: ProgramDriverJournalStore,
  context: StandardA2ARequestContext,
  contextId: string,
): Promise<ProgramDriverJournal> {
  return run(function* () {
    return yield* store.open(scopedSession(context, contextId));
  });
}
async function readJournal(journal: ProgramDriverJournal, sessionId: string) {
  return run(function* () {
    return yield* journal.readJournal(sessionId);
  });
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

async function authenticate(
  options: CreateStandardA2AHostOptions,
  request: Request,
): Promise<StandardA2ARequestContext> {
  const authenticated = await options.authenticate?.(request);
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
  return Object.freeze({ ...value });
}
async function authorize(
  options: CreateStandardA2AHostOptions,
  context: StandardA2ARequestContext,
  action: StandardA2AAuthorizationAction,
  resource: { readonly contextId?: string; readonly taskId?: string },
): Promise<void> {
  if (options.authorize && !(await options.authorize({ context, action, ...resource }))) {
    throw hostError("authorization_denied", "The requested operation is not authorized");
  }
  options.onTelemetry?.({ type: "request", action, ...resource });
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
    throw hostError("task_input_too_large", "A2A request body is invalid JSON");
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
function sseResponse(task: ForeignA2ATask, sdk03 = false): Response {
  return new Response(`event: task\ndata: ${canonicalJson({ task: wireTask(task, sdk03) })}\n\n`, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
function wireTask(task: ForeignA2ATask, sdk03 = false): Json {
  const state = {
    submitted: "TASK_STATE_SUBMITTED",
    working: "TASK_STATE_WORKING",
    input_required: "TASK_STATE_INPUT_REQUIRED",
    auth_required: "TASK_STATE_AUTH_REQUIRED",
    completed: "TASK_STATE_COMPLETED",
    failed: "TASK_STATE_FAILED",
    canceled: "TASK_STATE_CANCELED",
    rejected: "TASK_STATE_REJECTED",
  }[task.status.state];
  const message = (value: ForeignA2AMessage): Json => {
    const projection = {
      ...value,
      role: value.role === "user" ? "ROLE_USER" : "ROLE_AGENT",
    };
    if (!sdk03) {
      return projection;
    }
    const { parts, ...withoutParts } = projection;
    return { ...withoutParts, content: parts };
  };
  return {
    ...task,
    status: {
      ...task.status,
      state,
      ...(task.status.message ? { message: message(task.status.message) } : {}),
    },
    ...(task.history ? { history: task.history.map(message) } : {}),
  } as unknown as Json;
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
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function withLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) {
      locks.delete(key);
    }
  }
}
function payloadTaskId(payload: DurableSemanticRecord["payload"]): string | undefined {
  return "taskId" in payload ? payload.taskId : undefined;
}
