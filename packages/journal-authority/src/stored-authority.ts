import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  CrankError,
  type DurableReference,
  type ExecutionTreeSnapshot,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import type { DurableSchemaRegistry } from "./schema-registry.ts";
import type { ExecutionStore, VersionedExecution } from "./store.ts";
import { runExecutionCommitLoop } from "./commit-loop.ts";
import {
  InMemoryDurableJournalAuthority,
  parseDurableAuthoritySnapshot,
  type DurableAuthoritySnapshot,
  type DurableSemanticRecord,
  type OpenDurableTaskRequest,
} from "./durable-authority.ts";
import type {
  AppendEmissionRequest,
  BindRestoreFrontierRequest,
  BindRestoreFrontierResult,
  CancellationAcknowledgement,
  ClaimActivationRequest,
  ClaimActivationResult,
  CompleteTaskRequest,
  ConsumeRestoreTicketRequest,
  ConsumeRestoreTicketResult,
  DurableCancellationState,
  DurableOperationState,
  DurableTaskExecutionState,
  DurableTaskRecoveryState,
  EmissionReceipt,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  PrepareProgramRestoreRequest,
  PreparedProgramRestore,
  RecoverableSession,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  RenewActivationRequest,
  RenewActivationResult,
  RestoredFrontierProof,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "./durable-authority-types.ts";
import type { CapabilityKeyring } from "./capabilities.ts";
import type { ProgramStep } from "@sweatpants/durable-execution";

export interface StoredDurableJournalAuthorityOptions {
  readonly journalId: string;
  readonly journalIncarnation?: string;
  readonly keyring: CapabilityKeyring;
  readonly now?: () => number;
  readonly maxOutcomeBytes?: number;
  readonly schemaRegistry?: DurableSchemaRegistry;
  /** Test/import boundary for an already parsed snapshot; no storage adapter reads legacy keys. */
  readonly initialSnapshot?: DurableAuthoritySnapshot;
}

export interface StoredDurableJournalAuthority {
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  /** Returns authority-owned placement and catalog recovery state. */
  taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  /** Returns the canonical parsed input accepted for one task. */
  taskInput(sessionId: string, taskId: string): Operation<Json>;
  /** Selects active root work or its terminal value without exposing the journal. */
  taskRecoveryState(
    sessionId: string,
    requestedTaskId?: string,
  ): Operation<DurableTaskRecoveryState>;
  rootTaskCount(sessionId: string): Operation<number>;
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
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
  /** Orphans a task whose pinned program is unavailable or corrupt. */
  forceOrphan(
    sessionId: string,
    taskId: string,
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged",
  ): Operation<void>;
  /** Returns the current resolver capability for an existing pending pull. */
  resolutionCapability(sessionId: string, taskId: string, pullId: string): Operation<string>;
  /** Reads a parsed defensive semantic journal snapshot. */
  readJournal(sessionId: string): Operation<DurableSemanticRecord[]>;
  /** Reads one root tree without scanning completed sibling Turns. */
  readTaskJournal(sessionId: string, rootTaskId: string): Operation<DurableSemanticRecord[]>;
  /** Reads deterministic runnable session IDs. */
  runnableSessions(): Operation<string[]>;
  /** Exports the parsed authority state for explicit test/state-transfer boundaries. */
  exportSnapshot(): Operation<DurableAuthoritySnapshot>;
}

export function createStoredDurableJournalAuthority(
  store: ExecutionStore,
  options: StoredDurableJournalAuthorityOptions,
): StoredDurableJournalAuthority {
  const executionId = `authority:${options.journalId}`;
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
  };

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

  function* load(
    supplied?: VersionedExecution | null,
  ): Operation<{ revision: number | null; snapshot: DurableAuthoritySnapshot }> {
    const current = supplied === undefined ? yield* store.loadExecution(executionId) : supplied;
    if (!current) return { revision: null, snapshot: options.initialSnapshot ?? empty };
    if (current.record.format !== "sweatpants.execution-tree.v1" || !current.record.checkpoint) {
      throw new CrankError("invalid_journal", "Stored authority control record is invalid");
    }
    const payload = yield* store.getPayload(current.record.checkpoint);
    if (payload === null || payload instanceof Uint8Array) {
      throw new CrankError("invalid_journal", "Stored authority snapshot payload is unavailable");
    }
    return {
      revision: current.revision,
      snapshot: parseDurableAuthoritySnapshot(JSON.stringify(payload)),
    };
  }

  function control(checkpoint: DurableReference): ExecutionTreeSnapshot {
    return {
      format: "sweatpants.execution-tree.v1",
      executionId,
      sessionId: options.journalId,
      turnId: "authority",
      rootTaskId: "authority",
      rootProgram: { id: "journal-authority", version: "1", digest: "0".repeat(64) },
      tasks: [],
      runnableTaskIds: [],
      checkpoint,
      unpublishedProjection: { throughSequence: 0, facts: null },
    };
  }

  function* mutate<T>(
    operation: (value: InMemoryDurableJournalAuthority) => Operation<T>,
  ): Operation<T> {
    return yield* runExecutionCommitLoop(store, executionId, function* (current) {
      const loaded = yield* load(current);
      const value = authority(loaded.snapshot);
      const result = yield* operation(value);
      const snapshot = assertJson(canonicalSnapshot(value.exportSnapshot()).value);
      const checkpoint = yield* store.putPayload(snapshot);
      return { status: "commit", next: control(checkpoint), privateRecords: [], result };
    });
  }

  function* read<T>(select: (value: InMemoryDurableJournalAuthority) => T): Operation<T> {
    const loaded = yield* load();
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
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).taskExecutionState(sessionId, taskId);
    },
    *taskInput(sessionId, taskId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).taskInput(sessionId, taskId);
    },
    *taskRecoveryState(sessionId, requestedTaskId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).taskRecoveryState(sessionId, requestedTaskId);
    },
    *rootTaskCount(sessionId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).rootTaskCount(sessionId);
    },
    *operationState(sessionId, taskId, pullId) {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).operationState(sessionId, taskId, pullId);
    },
    *nonterminalSchemaDigests() {
      const loaded = yield* load();
      return yield* authority(loaded.snapshot).nonterminalSchemaDigests();
    },
    *markActivationStarted(sessionId) {
      yield* mutate((value) => value.markActivationStarted(sessionId));
    },
    *recoverableSessions() {
      const loaded = yield* load();
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
    *forceOrphan(sessionId, taskId, reason) {
      yield* mutate((value) => value.forceOrphan(sessionId, taskId, reason));
    },
    *resolutionCapability(sessionId, taskId, pullId) {
      return yield* read((value) => value.resolutionCapability(sessionId, taskId, pullId));
    },
    *readJournal(sessionId) {
      return yield* read((value) => value.readJournal(sessionId));
    },
    *readTaskJournal(sessionId, rootTaskId) {
      return yield* read((value) => value.readTaskJournal(sessionId, rootTaskId));
    },
    *runnableSessions() {
      return yield* read((value) => value.runnableSessions());
    },
    *exportSnapshot() {
      return yield* read((value) => value.exportSnapshot());
    },
  };
}
