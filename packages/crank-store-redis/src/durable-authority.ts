import { call, type Operation } from "effection";
import type { RedisClientType } from "redis";
import {
  CrankError,
  InMemoryDurableJournalAuthority,
  parseDurableAuthoritySnapshot,
  type AppendEmissionRequest,
  type BindRestoreFrontierRequest,
  type BindRestoreFrontierResult,
  type CapabilityKeyring,
  type CancellationAcknowledgement,
  type ClaimActivationRequest,
  type ClaimActivationResult,
  type CompleteTaskRequest,
  type ConsumeRestoreTicketRequest,
  type ConsumeRestoreTicketResult,
  type DurableAuthoritySnapshot,
  type DurableCancellationState,
  type DurableSemanticRecord,
  type DurableTaskExecutionState,
  type EmissionReceipt,
  type EnsureChildTaskRequest,
  type EnsureChildTaskResult,
  type IssueRestoreTicketRequest,
  type IssueRestoreTicketResult,
  type OpenDurableTaskRequest,
  type PrepareProgramRestoreRequest,
  type PreparedProgramRestore,
  type ProgramStep,
  type RecoverableSession,
  type ReserveOperationRequest,
  type ReserveOperationResult,
  type DurableSchemaRegistry,
  type Json,
  type ReleaseActivationRequest,
  type ReleaseActivationResult,
  type RenewActivationRequest,
  type RenewActivationResult,
  type RestoredFrontierProof,
  type ResolveOperationRequest,
  type ResolveOperationResult,
  type TaskCloseReceipt,
} from "@sweatpants/session-contract";

/** Redis authority configuration; keyring material remains process-local and is never persisted. */
export interface RedisDurableJournalAuthorityOptions {
  journalId: string;
  journalIncarnation?: string;
  keyring: CapabilityKeyring;
  keyPrefix?: string;
  now?: () => number;
  maxOutcomeBytes?: number;
  /**
   * Digest-keyed Standard Schema validator registry shared with the in-memory
   * authority path. Runtime validators are never persisted to Redis; every
   * CAS retry reloads state and reruns validation through this registry.
   */
  schemaRegistry?: DurableSchemaRegistry;
}

/** CAS-backed durable authority port with processless journal reads and recovery operations. */
export interface RedisDurableJournalAuthority {
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  /** Returns authority-owned placement and catalog recovery state. */
  taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  /** Returns the canonical parsed input accepted for one task. */
  taskInput(sessionId: string, taskId: string): Operation<Json>;
  /** Lists exact schema digests referenced by nonterminal tasks. */
  nonterminalSchemaDigests(): Operation<string[]>;
  /** Clears the runnable marker when an accepted activation starts. */
  markActivationStarted(sessionId: string): Operation<void>;
  recoverableSessions(): Operation<RecoverableSession[]>;
  claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult>;
  renewActivation(request: RenewActivationRequest): Operation<RenewActivationResult>;
  releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult>;
  issueRestoreTicket(request: IssueRestoreTicketRequest): Operation<IssueRestoreTicketResult>;
  prepareProgramRestore(request: PrepareProgramRestoreRequest): Operation<PreparedProgramRestore>;
  bindRestoreFrontier(request: BindRestoreFrontierRequest): Operation<BindRestoreFrontierResult>;
  consumeRestoreTicket(request: ConsumeRestoreTicketRequest): Operation<ConsumeRestoreTicketResult>;
  /** Reads durable cancellation lifecycle state. */
  cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState>;
  /** Starts one-shot authored cancellation unwind. */
  beginCancellationUnwind(
    sessionId: string,
    taskId: string,
    restoredFrontier?: { readonly proof: RestoredFrontierProof; readonly step: ProgramStep },
  ): Operation<DurableCancellationState>;
  /** Binds current program authority under Redis CAS fencing. */
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  /** Idempotently allocates a deterministic child task. */
  ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
  /** Atomically reserves an operation before host dispatch. */
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  /** Atomically commits a capability-authorized outcome. */
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  /** Atomically appends an ordered durable emission. */
  emit(request: AppendEmissionRequest): Operation<EmissionReceipt>;
  /** Atomically closes a task after output validation. */
  complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt>;
  /** Opens one pinned task exactly once. */
  openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }>;
  /** Fences an old attachment and advances its execution epoch. */
  replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    audience?: string,
  ): Operation<{ executionEpoch: number; programCapability: string }>;
  /** Idempotently records logical task cancellation. */
  requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): Operation<CancellationAcknowledgement>;
  /** Detaches an in-flight attempt and applies its declared indeterminate policy. */
  detachAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    reason?: string,
  ): Operation<void>;
  /** Revokes an attempt that can no longer resolve. */
  abandonAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    attemptId: string,
    reason?: string,
  ): Operation<void>;
  /** Retries unsafe ambiguity only after explicit duplicate-risk acknowledgement. */
  retryIndeterminateEffect(
    sessionId: string,
    taskId: string,
    pullId: string,
    acknowledgeDuplicateRisk: boolean,
  ): Operation<ReserveOperationResult>;
  /** Orphans a task whose pinned program is unavailable or corrupt. */
  forceOrphan(
    sessionId: string,
    taskId: string,
    reason: "program_version_unavailable" | "program_corrupt" | "cleanup_stuck",
  ): Operation<void>;
  /** Returns the current resolver capability for an existing pending pull. */
  resolutionCapability(sessionId: string, taskId: string, pullId: string): Operation<string>;
  /** Reads a parsed defensive semantic journal snapshot. */
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  /** Reads deterministic runnable session IDs. */
  runnableSessions(): Operation<string[]>;
}

const CAS_SNAPSHOT = `
local current = redis.call('GET', KEYS[1])
if (current or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

/**
 * Creates a Redis-backed authority. Each mutation reloads, parses, applies, and
 * atomically CAS-writes a complete snapshot; retry exhaustion throws CrankError.
 */
export function createRedisDurableJournalAuthority(
  client: RedisClientType,
  options: RedisDurableJournalAuthorityOptions,
): RedisDurableJournalAuthority {
  const key = `${options.keyPrefix ?? "sweatpants:crank:"}durable-authority:${encodeURIComponent(options.journalId)}`;
  const empty: DurableAuthoritySnapshot = {
    version: 4,
    tasks: [],
    records: [],
    runnable: [],
    nonce: 0,
    activationLeases: [],
    lastActivationEpochBySession: [],
    taskRevisions: [],
    restoreNonces: [],
    restoreFrontierDigests: [],
    consecutiveRestoreStales: [],
    activationNotBeforeMs: [],
    placements: [],
  };

  async function load(): Promise<{ raw: string; snapshot: DurableAuthoritySnapshot }> {
    const raw = await client.get(key);
    return {
      raw: raw ?? "",
      snapshot: raw ? parseDurableAuthoritySnapshot(raw) : empty,
    };
  }

  function authority(snapshot: DurableAuthoritySnapshot): InMemoryDurableJournalAuthority {
    return new InMemoryDurableJournalAuthority({
      journalId: options.journalId,
      keyring: options.keyring,
      snapshot,
      ...(options.journalIncarnation !== undefined
        ? { journalIncarnation: options.journalIncarnation }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.maxOutcomeBytes !== undefined
        ? { maxOutcomeBytes: options.maxOutcomeBytes }
        : {}),
      ...(options.schemaRegistry !== undefined ? { schemaRegistry: options.schemaRegistry } : {}),
    });
  }

  function* mutate<T>(
    operation: (value: InMemoryDurableJournalAuthority) => Operation<T>,
  ): Operation<T> {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const loaded = yield* call(load);
      const value = authority(loaded.snapshot);
      const result = yield* operation(value);
      const encoded = JSON.stringify(value.exportSnapshot());
      const accepted = yield* call(() =>
        client.eval(CAS_SNAPSHOT, {
          keys: [key],
          arguments: [loaded.raw, encoded],
        }),
      );
      if (Number(accepted) === 1) {
        return result;
      }
    }
    throw new CrankError(
      "cas_contention",
      "Redis durable authority update contention exceeded its retry budget",
    );
  }

  function* read<T>(select: (value: InMemoryDurableJournalAuthority) => T): Operation<T> {
    const loaded = yield* call(load);
    return select(authority(loaded.snapshot));
  }

  return {
    journalIdentity() {
      return {
        id: options.journalId,
        incarnation: options.journalIncarnation ?? "1",
      };
    },
    *taskExecutionState(sessionId, taskId) {
      const loaded = yield* call(load);
      return yield* authority(loaded.snapshot).taskExecutionState(sessionId, taskId);
    },
    *taskInput(sessionId, taskId) {
      const loaded = yield* call(load);
      return yield* authority(loaded.snapshot).taskInput(sessionId, taskId);
    },
    *nonterminalSchemaDigests() {
      const loaded = yield* call(load);
      return yield* authority(loaded.snapshot).nonterminalSchemaDigests();
    },
    *markActivationStarted(sessionId) {
      yield* mutate((value) => value.markActivationStarted(sessionId));
    },
    *recoverableSessions() {
      const loaded = yield* call(load);
      return yield* authority(loaded.snapshot).recoverableSessions();
    },
    *claimActivation(request) {
      return yield* mutate((value) => value.claimActivation(request));
    },
    *renewActivation(request) {
      return yield* mutate((value) => value.renewActivation(request));
    },
    *releaseActivation(request) {
      return yield* mutate((value) => value.releaseActivation(request));
    },
    *issueRestoreTicket(request) {
      return yield* mutate((value) => value.issueRestoreTicket(request));
    },
    *prepareProgramRestore(request) {
      return yield* mutate((value) => value.prepareProgramRestore(request));
    },
    *bindRestoreFrontier(request) {
      return yield* mutate((value) => value.bindRestoreFrontier(request));
    },
    *consumeRestoreTicket(request) {
      return yield* mutate((value) => value.consumeRestoreTicket(request));
    },
    *cancellationState(sessionId, taskId) {
      return yield* mutate((value) => value.cancellationState(sessionId, taskId));
    },
    *beginCancellationUnwind(sessionId, taskId, restoredFrontier) {
      return yield* mutate((value) =>
        value.beginCancellationUnwind(sessionId, taskId, restoredFrontier),
      );
    },
    *bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch) {
      return yield* mutate((value) =>
        value.bindProgramAttachment(sessionId, taskId, attachmentId, executionEpoch),
      );
    },
    *openTask(request) {
      return yield* mutate((value) => value.openTask(request));
    },
    *ensureChildTask(request) {
      return yield* mutate((value) => value.ensureChildTask(request));
    },
    *replaceAttachment(sessionId, taskId, attachmentId, audience) {
      return yield* mutate((value) =>
        value.replaceAttachment(sessionId, taskId, attachmentId, audience),
      );
    },
    *reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
      return yield* mutate((value) => value.reserve(request));
    },
    *resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
      return yield* mutate((value) => value.resolve(request));
    },
    *emit(request: AppendEmissionRequest): Operation<EmissionReceipt> {
      return yield* mutate((value) => value.emit(request));
    },
    *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
      return yield* mutate((value) => value.complete(request));
    },
    *requestCancellation(sessionId, taskId, reason, commandId) {
      return yield* mutate((value) =>
        value.requestCancellation(sessionId, taskId, reason, commandId),
      );
    },
    *detachAttempt(sessionId, taskId, pullId, reason) {
      yield* mutate((value) => value.detachAttempt(sessionId, taskId, pullId, reason));
    },
    *abandonAttempt(sessionId, taskId, pullId, attemptId, reason) {
      yield* mutate((value) => value.abandonAttempt(sessionId, taskId, pullId, attemptId, reason));
    },
    *retryIndeterminateEffect(sessionId, taskId, pullId, acknowledgeDuplicateRisk) {
      return yield* mutate((value) =>
        value.retryIndeterminateEffect(sessionId, taskId, pullId, acknowledgeDuplicateRisk),
      );
    },
    *forceOrphan(sessionId, taskId, reason) {
      yield* mutate((value) => value.forceOrphan(sessionId, taskId, reason));
    },
    *resolutionCapability(sessionId, taskId, pullId) {
      return yield* read((value) => value.resolutionCapability(sessionId, taskId, pullId));
    },
    *readJournal(sessionId) {
      return yield* read((value) => value.readJournal(sessionId));
    },
    *runnableSessions() {
      return yield* read((value) => value.runnableSessions());
    },
  };
}
