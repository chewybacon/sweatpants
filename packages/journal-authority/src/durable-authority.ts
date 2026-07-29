import {
  CrankError,
  assertInlineSize,
  DEFAULT_MAX_INLINE_BYTES,
} from "@sweatpants/durable-execution";
import type { Operation } from "effection";
import type { OperationOutcome } from "@sweatpants/durable-effects";

import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  NULL_RESULT_SCHEMA_DESCRIPTOR,
} from "@sweatpants/durable-execution";
import {
  createDurableSchemaRegistry,
  validateRegisteredSchema,
  type DurableSchemaRegistry,
  type RegistrySchemaValidation,
} from "./schema-registry.ts";
import {
  signCapability,
  signPrivateAuthorityToken,
  verifyPrivateAuthorityToken,
  verifyProgramCapability,
  verifyResolutionCapability,
  type CapabilityKeyring,
} from "./capabilities.ts";
import {
  assertJson,
  canonicalJson,
  canonicalSnapshot,
  sha256,
  stableOpaqueId,
} from "@sweatpants/foundation";
import { type Json } from "@sweatpants/foundation";
import {
  effectContractDigest,
  hasLiveDurableEffect,
  signalLiveDurableEffect,
} from "@sweatpants/durable-effects/runtime";
import type {
  ActivationLeaseState,
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
  DurableJournalAuthorityService,
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
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolutionCapabilityClaims,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  RenewActivationRequest,
  RenewActivationResult,
  RestoredFrontierProof,
  ResolveOperationRequest,
  ResolveOperationResult,
  RestoreTicketClaims,
  TaskCloseReceipt,
} from "./durable-authority-types.ts";
import type {
  DurableOperationDescriptor,
  DurableProgramManifest,
  ProgramRoute,
  ProgramStep,
  ReplayEmissionEntry,
  ReplayEntry,
  ReplayOperationEntry,
  ResolutionReceipt,
} from "@sweatpants/durable-execution";

/** Closed attempt-state algebra persisted by the authority. */
export type DurableAttemptState = "started" | "detached" | "completed" | "revoked" | "superseded";

/** Append-only semantic journal record; payload variants are replay-stable. */
export type DurableSemanticRecord = {
  offset: string;
  eventId: string;
  sessionId: string;
  ownerEpoch?: number;
  payload:
    | {
        type: "TaskOpened";
        taskId: string;
        turnId: string;
        programId: string;
        programVersion: string;
        programDigest: string;
        input: Json;
        inputDigest: string;
        /** Exact Host-bound catalog accepted before first driver execution. */
        catalog?: Json;
        catalogDigest?: string;
        parentTaskId?: string;
        parentPullId?: string;
      }
    | {
        type: "PullRequested";
        taskId: string;
        turnId: string;
        actionIndex: number;
        pullIndex: number;
        pullId: string;
        descriptor: DurableOperationDescriptor;
        descriptorDigest: string;
      }
    | {
        type: "AttemptStarted";
        taskId: string;
        pullId: string;
        attemptId: string;
        attemptIndex: number;
      }
    | { type: "AttemptDetached"; taskId: string; pullId: string; attemptId: string; reason: string }
    | {
        type: "AttemptAbandoned";
        taskId: string;
        pullId: string;
        attemptId: string;
        reason: string;
      }
    | {
        type: "AttemptSuperseded";
        taskId: string;
        pullId: string;
        attemptId: string;
        winnerAttemptId: string;
      }
    | { type: "PullIndeterminate"; taskId: string; pullId: string; attemptId: string }
    | {
        type: "PullResolved";
        taskId: string;
        pullId: string;
        attemptId?: string;
        outcome: OperationOutcome;
        outcomeDigest: string;
      }
    | {
        type: "DurableEmission";
        taskId: string;
        actionIndex: number;
        emissionIndex: number;
        descriptor: { eventType: string; payload: Json };
        descriptorDigest: string;
      }
    | {
        type: "RaceWinnerSelected";
        taskId: string;
        pullId: string;
        winnerTaskId: string;
        closeOffset: string;
        outcomeDigest: string;
      }
    | {
        type: "CancellationRequested";
        taskId: string;
        commandId: string;
        reason?: string;
        frontier: { actionIndex: number; pullId?: string };
      }
    | {
        type: "CancellationPartialDiscarded";
        taskId: string;
        pullId: string;
        reason: "schema_validation_failed" | "payload_too_large" | "schema_version_unavailable";
      }
    | {
        type: "AttemptOutcomeUnknown";
        taskId: string;
        pullId: string;
        attemptId?: string;
        reason: "no_settlement_path" | "force_orphaned";
      }
    | {
        type: "CleanupSkipped";
        taskId: string;
        reason:
          | "program_version_unavailable"
          | "program_corrupt"
          | "cleanup_stuck"
          | "replay_execution_failed"
          | "replay_diverged";
      }
    | {
        type: "TaskOrphaned";
        taskId: string;
        reason:
          | "program_version_unavailable"
          | "program_corrupt"
          | "cleanup_stuck"
          | "replay_execution_failed"
          | "replay_diverged";
      }
    | { type: "TaskClosed"; taskId: string; outcome: OperationOutcome };
};

type Attempt = {
  attemptId: string;
  attemptIndex: number;
  state: DurableAttemptState;
  capability: string;
};

type Pull = {
  pullId: string;
  actionIndex: number;
  pullIndex: number;
  descriptor: DurableOperationDescriptor;
  descriptorDigest: string;
  effectiveDescriptor: DurableOperationDescriptor;
  resultDescriptor: PortableSchemaDescriptor;
  resultSchemaDigest: string;
  audience: string;
  maxOutcomeBytes: number;
  attempts: Attempt[];
  capability?: string;
  outcome?: OperationOutcome;
  outcomeDigest?: string;
  receipt?: ResolutionReceipt;
  revoked: boolean;
};

export interface SemanticEmissionPolicy {
  maxEmissionsPerTask?: number;
  maxCumulativeEmissionBytes?: number;
}

type Task = {
  sessionId: string;
  turnId: string;
  taskId: string;
  manifest: DurableProgramManifest;
  input: Json;
  executionEpoch: number;
  attachmentId: string;
  audience: string;
  nextActionIndex: number;
  nextPullIndex: number;
  nextEmissionIndex: number;
  pullsByAction: Map<number, Pull>;
  emissionsByAction: Map<number, { digest: string; receipt: EmissionReceipt }>;
  emissionPolicy?: SemanticEmissionPolicy;
  acceptedEmissionCount?: number;
  cumulativeEmissionBytes?: number;
  status: "active" | "closed" | "cancelled" | "orphaned";
  cancellation: DurableCancellationState;
  catalog?: Json;
  catalogDigest?: string;
  route?: ProgramRoute;
  close?: { digest: string; receipt: TaskCloseReceipt };
  parentTaskId?: string;
  parentPullId?: string;
};

type TaskSnapshot = Omit<Task, "pullsByAction" | "emissionsByAction"> & {
  pullsByAction: Array<[number, Pull]>;
  emissionsByAction: Array<[number, { digest: string; receipt: EmissionReceipt }]>;
};

/** Versioned canonical snapshot DTO used only after boundary parsing. */
export interface DurableAuthoritySnapshot {
  version: 4;
  tasks: TaskSnapshot[];
  records: Array<[string, DurableSemanticRecord[]]>;
  runnable: string[];
  nonce: number;
  activationLeases: Array<[string, ActivationLeaseState]>;
  lastActivationEpochBySession: Array<[string, number]>;
  taskRevisions: Array<[string, number]>;
  restoreNonces: Array<[string, string]>;
  restoreFrontierDigests: Array<[string, string]>;
  consecutiveRestoreStales: Array<[string, number]>;
  activationNotBeforeMs: Array<[string, number]>;
}

/** Composition options for a process-local authority and optional parsed snapshot. */
export interface InMemoryDurableJournalOptions {
  journalId: string;
  journalIncarnation?: string;
  keyring: CapabilityKeyring;
  now?: () => number;
  maxOutcomeBytes?: number;
  /** Optional defaults copied into each newly opened task. */
  emissionPolicy?: SemanticEmissionPolicy;
  snapshot?: DurableAuthoritySnapshot;
  /**
   * Digest-keyed Standard Schema validator registry used for every ownerless
   * command-lane validation. Defaults to the built-in registry (null/any and
   * the foreign adapter catalog); deployments merge their generated validator
   * catalogs into this registry.
   */
  schemaRegistry?: DurableSchemaRegistry;
}

/** Complete root/child task identity and pinned program input required to open a task. */
export interface OpenDurableTaskRequest {
  sessionId: string;
  turnId: string;
  taskId: string;
  manifest: DurableProgramManifest;
  input: Json;
  executionEpoch: number;
  attachmentId: string;
  audience: string;
  /** Exact Host-bound catalog and route retained independently of process memory. */
  catalog?: Json;
  catalogDigest?: string;
  route?: ProgramRoute;
  parentTaskId?: string;
  parentPullId?: string;
}

/**
 * Canonical authority implementation used as the semantic baseline. Mutations
 * are synchronous within an Effection scope and snapshots are deep copies.
 */
export class InMemoryDurableJournalAuthority implements DurableJournalAuthorityService {
  readonly #tasks = new Map<string, Task>();
  readonly #records = new Map<string, DurableSemanticRecord[]>();
  readonly #runnable = new Set<string>();
  readonly #activationLeases = new Map<string, ActivationLeaseState>();
  readonly #lastActivationEpochBySession = new Map<string, number>();
  readonly #taskRevisions = new Map<string, number>();
  readonly #restoreNonces = new Map<string, string>();
  readonly #restoreFrontierDigests = new Map<string, string>();
  readonly #consecutiveRestoreStales = new Map<string, number>();
  readonly #activationNotBeforeMs = new Map<string, number>();
  readonly #options: Required<
    Omit<
      InMemoryDurableJournalOptions,
      "keyring" | "snapshot" | "schemaRegistry" | "emissionPolicy"
    >
  > & {
    keyring: CapabilityKeyring;
    emissionPolicy?: SemanticEmissionPolicy;
  };
  readonly #schemas: DurableSchemaRegistry;
  #nonce = 0;

  /** Creates an empty authority or restores a previously parsed snapshot. */
  constructor(options: InMemoryDurableJournalOptions) {
    if (!options.journalId) {
      throw new CrankError("invalid_manifest", "journalId is required");
    }
    const { schemaRegistry, emissionPolicy, ...rest } = options;
    const normalizedEmissionPolicy = normalizeEmissionPolicy(emissionPolicy);
    this.#options = {
      ...rest,
      journalIncarnation: options.journalIncarnation ?? "1",
      now: options.now ?? Date.now,
      maxOutcomeBytes: options.maxOutcomeBytes ?? DEFAULT_MAX_INLINE_BYTES,
      ...(normalizedEmissionPolicy ? { emissionPolicy: normalizedEmissionPolicy } : {}),
    };
    this.#schemas = schemaRegistry ?? createDurableSchemaRegistry();
    if (options.snapshot) {
      this.#restore(options.snapshot);
    }
  }

  journalIdentity(): { readonly id: string; readonly incarnation: string } {
    return { id: this.#options.journalId, incarnation: this.#options.journalIncarnation };
  }

  *taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState> {
    const task = this.#task(sessionId, taskId);
    return {
      executionEpoch: task.executionEpoch,
      ...(task.route !== undefined ? { route: structuredClone(task.route) } : {}),
      ...(task.catalog
        ? { catalog: structuredClone(task.catalog), catalogDigest: task.catalogDigest! }
        : {}),
    };
  }

  *taskRecoveryState(
    sessionId: string,
    requestedTaskId?: string,
  ): Operation<DurableTaskRecoveryState> {
    const tasks = [...this.#tasks.values()].filter((task) => task.sessionId === sessionId);
    const active = tasks.filter((task) => task.status === "active");

    let selected: Task | undefined;
    if (requestedTaskId) {
      selected = active.find((task) => task.taskId === requestedTaskId);
      while (selected?.parentTaskId) {
        selected = active.find((task) => task.taskId === selected!.parentTaskId);
      }
    } else {
      selected = active.filter((task) => !task.parentTaskId).at(-1);
    }

    if (selected) {
      return {
        status: "active",
        sessionId: selected.sessionId,
        turnId: selected.turnId,
        taskId: selected.taskId,
        manifest: structuredClone(selected.manifest),
        input: structuredClone(selected.input),
        activeTasks: active.map((task) => ({
          taskId: task.taskId,
          executionEpoch: task.executionEpoch,
        })),
      };
    }

    const terminalTaskId =
      requestedTaskId ?? tasks.filter((task) => !task.parentTaskId).at(-1)?.taskId;
    if (terminalTaskId) {
      const terminal = [...(this.#records.get(sessionId) ?? [])]
        .reverse()
        .find(
          (record) =>
            record.payload.type === "TaskClosed" && record.payload.taskId === terminalTaskId,
        );
      if (terminal?.payload.type === "TaskClosed") {
        return {
          status: "terminal",
          taskId: terminalTaskId,
          outcome: structuredClone(terminal.payload.outcome),
        };
      }
    }
    return { status: "not_found" };
  }

  *rootTaskCount(sessionId: string): Operation<number> {
    const roots = [...this.#tasks.values()].filter(
      (task) => task.sessionId === sessionId && !task.parentTaskId,
    );
    const ordinal = roots.reduce((maximum, task) => {
      const match = /^turn-(\d+)(?:\/root)?$/.exec(task.taskId);
      return match ? Math.max(maximum, Number(match[1]) + 1) : maximum;
    }, 0);
    return Math.max(roots.length, ordinal);
  }

  *operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState> {
    const task = this.#tasks.get(taskKey(sessionId, taskId));
    const pull = task
      ? [...task.pullsByAction.values()].find((candidate) => candidate.pullId === pullId)
      : undefined;
    if (!pull) {
      return { status: "not_found" };
    }
    return {
      status: "found",
      descriptor: structuredClone(pull.descriptor),
      audience: pull.audience,
      ...(pull.outcome !== undefined ? { outcome: structuredClone(pull.outcome) } : {}),
    };
  }

  /** Opens one pinned task exactly once and returns attachment-bound authority. */
  *openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }> {
    const key = taskKey(request.sessionId, request.taskId);
    if (this.#tasks.has(key)) {
      throw new CrankError("invalid_journal", "Task already exists");
    }
    const input = yield* this.#validateThroughRegistry(
      request.manifest.inputSchema.digest,
      request.input,
      "invalid_descriptor",
    );
    // Async validation re-entry: reject if a competing open won while the
    // registry validator awaited.
    if (this.#tasks.has(key)) {
      throw new CrankError("invalid_journal", "Task already exists");
    }
    this.#assertEffectContractsCompatible(request.manifest);
    assertInlineSize(input, this.#options.maxOutcomeBytes);
    if ((request.catalog === undefined) !== (request.catalogDigest === undefined)) {
      throw new CrankError(
        "invalid_manifest",
        "Catalog and catalog digest must be supplied together",
      );
    }
    const catalog =
      request.catalog === undefined ? undefined : canonicalSnapshot(request.catalog).value;
    if (catalog && (!isJsonRecord(catalog) || catalog["digest"] !== request.catalogDigest)) {
      throw new CrankError("invalid_manifest", "Accepted catalog digest differs");
    }
    if (catalog) {
      assertInlineSize(catalog, this.#options.maxOutcomeBytes);
    }
    const route = request.route === undefined ? undefined : canonicalSnapshot(request.route).value;
    const emissionPolicy = this.#options.emissionPolicy
      ? structuredClone(this.#options.emissionPolicy)
      : undefined;
    const task: Task = {
      ...request,
      input,
      ...(catalog ? { catalog, catalogDigest: request.catalogDigest! } : {}),
      ...(route !== undefined ? { route } : {}),
      nextActionIndex: 0,
      nextPullIndex: 0,
      nextEmissionIndex: 0,
      pullsByAction: new Map(),
      emissionsByAction: new Map(),
      ...(emissionPolicy
        ? {
            emissionPolicy,
            acceptedEmissionCount: 0,
            cumulativeEmissionBytes: 0,
          }
        : {}),
      status: "active",
      cancellation: { type: "none" },
    };
    this.#tasks.set(key, task);
    this.#append(request.sessionId, request.executionEpoch, {
      type: "TaskOpened",
      taskId: request.taskId,
      turnId: request.turnId,
      programId: request.manifest.programId,
      programVersion: request.manifest.version,
      programDigest: request.manifest.digest,
      input,
      inputDigest: canonicalSnapshot(input).sha,
      ...(catalog ? { catalog, catalogDigest: request.catalogDigest! } : {}),
      ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
      ...(request.parentPullId ? { parentPullId: request.parentPullId } : {}),
    });
    this.#runnable.add(request.sessionId);
    return { programCapability: this.#programCapability(task) };
  }

  /** Rebinds an existing task only at its current fenced execution epoch. */
  *bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }> {
    const task = this.#task(sessionId, taskId);
    this.#runnable.delete(sessionId);
    this.#assertActive(task);
    if (task.executionEpoch !== executionEpoch) {
      throw new CrankError("stale_program_capability", "Attachment epoch is not current");
    }
    if (task.attachmentId !== attachmentId) {
      for (const pull of task.pullsByAction.values()) {
        this.#detachAttempts(task, pull, "attachment_replaced");
      }
      task.attachmentId = attachmentId;
    }
    return { programCapability: this.#programCapability(task) };
  }

  /** Idempotently allocates a deterministic child for an authorized invoke pull. */
  *ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult> {
    const parent = this.#task(request.sessionId, request.parentTaskId);
    this.#assertActive(parent);
    const parentPull = this.#pull(parent, request.parentPullId);
    if (parentPull.descriptor.kind !== "invoke") {
      throw new CrankError("invalid_descriptor", "Parent pull is not a child invocation");
    }
    const expected = parentPull.descriptor.child;
    if (
      expected.id !== request.child.id ||
      expected.version !== request.child.version ||
      expected.digest !== request.child.digest ||
      canonicalSnapshot(expected.input).sha !== canonicalSnapshot(request.child.input).sha
    ) {
      throw new CrankError("nondeterminism_detected", "Child descriptor differs from parent pull");
    }
    const existing = [...this.#tasks.values()].find(
      (task) =>
        task.sessionId === request.sessionId &&
        task.parentTaskId === request.parentTaskId &&
        task.parentPullId === request.parentPullId,
    );
    if (existing) {
      if (
        existing.manifest.programId !== request.manifest.programId ||
        existing.manifest.version !== request.manifest.version ||
        existing.manifest.digest !== request.manifest.digest
      ) {
        throw new CrankError("program_version_mismatch");
      }
      const outcome = this.#closedOutcome(existing.sessionId, existing.taskId);
      return {
        taskId: existing.taskId,
        ...(outcome ? { outcome } : {}),
      };
    }
    const childOrdinal = [...this.#tasks.values()].filter(
      (task) => task.sessionId === request.sessionId && task.parentTaskId === request.parentTaskId,
    ).length;
    const taskId = `${request.parentTaskId}.${childOrdinal}`;
    yield* this.openTask({
      sessionId: request.sessionId,
      turnId: request.turnId,
      taskId,
      manifest: request.manifest,
      input: request.child.input,
      executionEpoch: request.executionEpoch,
      attachmentId: "unattached-child",
      audience: request.audience,
      ...(parent.catalog ? { catalog: parent.catalog, catalogDigest: parent.catalogDigest! } : {}),
      ...(request.route !== undefined ? { route: request.route } : {}),
      parentTaskId: request.parentTaskId,
      parentPullId: request.parentPullId,
    });
    return { taskId };
  }

  /** Fences an old attachment and advances the task execution epoch. */
  *replaceAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    audience?: string,
  ): Operation<{ executionEpoch: number; programCapability: string }> {
    if (this.#activationLeases.has(sessionId)) {
      throw new CrankError(
        "stale_activation",
        "replaceAttachment is not valid for a lease-managed session",
      );
    }
    const task = this.#task(sessionId, taskId);
    this.#assertActive(task);
    for (const pull of task.pullsByAction.values()) {
      this.#detachAttempts(task, pull, "attachment_replaced");
    }
    task.executionEpoch += 1;
    task.attachmentId = attachmentId;
    if (audience !== undefined) {
      task.audience = audience;
    }
    return {
      executionEpoch: task.executionEpoch,
      programCapability: this.#programCapability(task),
    };
  }

  /** Reserves or replays one action-indexed pull before host dispatch. */
  *reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult> {
    const task = this.#task(request.sessionId, request.taskId);
    this.#assertProgram(request.programCapability, task);
    this.#assertActive(task);
    if (request.turnId !== task.turnId) {
      throw new CrankError("invalid_descriptor", "Turn identity mismatch");
    }
    const descriptor = snapshotDescriptor(request.descriptor);
    const descriptorDigest = canonicalSnapshot(descriptor).sha;
    const existing = task.pullsByAction.get(request.actionIndex);
    if (existing) {
      if (
        existing.descriptorDigest !== descriptorDigest ||
        existing.pullIndex !== request.pullIndex
      ) {
        throw new CrankError("nondeterminism_detected", "Recorded operation descriptor differs", {
          taskId: task.taskId,
          actionIndex: request.actionIndex,
          expectedDigest: existing.descriptorDigest,
          actualDigest: descriptorDigest,
        });
      }
      if (existing.outcome && existing.receipt) {
        return {
          status: "resolved",
          outcome: structuredClone(existing.outcome),
          receipt: { ...existing.receipt, status: "duplicate" },
        };
      }
      if (descriptor.kind === "effect" || descriptor.kind === "record") {
        return this.#authorizeExisting(task, existing);
      }
      existing.capability ??= this.#resolutionCapability(task, existing, undefined);
      return {
        status: "pending",
        pullId: existing.pullId,
        reason: pendingReason(descriptor),
        resolutionCapability: existing.capability,
      };
    }
    const verifyReservable = () => {
      this.#assertProgram(request.programCapability, task);
      this.#assertActive(task);
      if (request.turnId !== task.turnId) {
        throw new CrankError("invalid_descriptor", "Turn identity mismatch");
      }
      if (
        task.cancellation.type !== "none" &&
        task.cancellation.type !== "unwinding" &&
        task.cancellation.type !== "cancelled" &&
        task.cancellation.type !== "orphaned" &&
        request.actionIndex >= task.cancellation.frontier.actionIndex
      ) {
        throw new CrankError("cancellation_blocked", "Cancellation must unwind before new work");
      }
      if (
        request.actionIndex !== task.nextActionIndex ||
        request.pullIndex !== task.nextPullIndex ||
        task.pullsByAction.has(request.actionIndex)
      ) {
        throw new CrankError(
          "nondeterminism_detected",
          "Task-local action or pull cursor mismatch",
        );
      }
    };
    verifyReservable();
    const policy = operationPolicy(task.manifest, descriptor);
    let effectiveDescriptor = descriptor;
    if (descriptor.kind === "wait" && descriptor.durationMs !== undefined) {
      effectiveDescriptor = {
        ...descriptor,
        notBefore: new Date(this.#options.now() + descriptor.durationMs).toISOString(),
      };
    }
    if (descriptor.kind === "effect") {
      // Effect input transforms/defaults run exactly once here; the canonical
      // parsed input becomes the durable effective descriptor.
      const parsedInput = yield* this.#validateThroughRegistry(
        policy.inputDigest!,
        descriptor.input,
        "invalid_descriptor",
      );
      effectiveDescriptor = { ...descriptor, input: parsedInput };
    }
    if (descriptor.kind === "elicit" && policy.contextDigest && descriptor.context !== undefined) {
      const parsedContext = yield* this.#validateThroughRegistry(
        policy.contextDigest,
        descriptor.context,
        "invalid_descriptor",
      );
      effectiveDescriptor = { ...descriptor, context: parsedContext };
    }
    // Registry validators may await; re-verify authentication, task state, and
    // cursors immediately before the append.
    verifyReservable();
    const restoredFrontierConsumed = request.restoredFrontier !== undefined;
    if (request.restoredFrontier) {
      yield* this.#consumeRestoredFrontier(
        request.restoredFrontier,
        request.restoredFrontierStep,
        task,
      );
    }
    const pullId = stableOpaqueId("pull", [
      request.sessionId,
      request.turnId,
      request.taskId,
      request.pullIndex,
    ]);
    const pull: Pull = {
      pullId,
      actionIndex: request.actionIndex,
      pullIndex: request.pullIndex,
      descriptor,
      descriptorDigest,
      effectiveDescriptor,
      resultDescriptor: policy.resultDescriptor,
      resultSchemaDigest: policy.resultDescriptor.digest,
      audience: policy.audience,
      maxOutcomeBytes: this.#options.maxOutcomeBytes,
      attempts: [],
      revoked: false,
    };
    task.pullsByAction.set(request.actionIndex, pull);
    task.nextPullIndex += 1;
    this.#append(task.sessionId, task.executionEpoch, {
      type: "PullRequested",
      taskId: task.taskId,
      turnId: task.turnId,
      actionIndex: pull.actionIndex,
      pullIndex: pull.pullIndex,
      pullId,
      descriptor: effectiveDescriptor,
      descriptorDigest,
    });
    if (descriptor.kind === "effect" || descriptor.kind === "record") {
      return {
        ...this.#startAttempt(task, pull),
        ...(restoredFrontierConsumed ? { restoredFrontierConsumed: true as const } : {}),
      };
    }
    pull.capability = this.#resolutionCapability(task, pull, undefined);
    return {
      status: "pending",
      pullId,
      reason: pendingReason(descriptor),
      resolutionCapability: pull.capability,
      ...(restoredFrontierConsumed ? { restoredFrontierConsumed: true as const } : {}),
    };
  }

  /** Commits one schema-valid outcome under an audience-bound capability. */
  *resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult> {
    let claims: ResolutionCapabilityClaims;
    try {
      claims = verifyResolutionCapability(
        request.capability,
        this.#options.keyring,
        request.audience,
      );
    } catch (error) {
      if (error instanceof CrankError && error.code === "wrong_audience") {
        return { status: "rejected", code: "wrong_audience" };
      }
      return { status: "rejected", code: "invalid_resolution_capability" };
    }
    if (
      claims.journalId !== this.#options.journalId ||
      claims.journalIncarnation !== this.#options.journalIncarnation
    ) {
      return { status: "rejected", code: "invalid_resolution_capability" };
    }
    const task = this.#tasks.get(taskKey(claims.sessionId, claims.taskId));
    if (!task) {
      return { status: "rejected", code: "pull_not_found" };
    }
    const pull = [...task.pullsByAction.values()].find(
      (candidate) => candidate.pullId === claims.pullId,
    );
    if (!pull) {
      return { status: "rejected", code: "pull_not_found" };
    }
    const attempt =
      claims.attemptId === "none"
        ? undefined
        : pull.attempts.find((candidate) => candidate.attemptId === claims.attemptId);
    const verifyResolvable = ():
      | Extract<ResolveOperationResult, { status: "rejected" }>
      | undefined => {
      if (
        pull.descriptorDigest !== claims.descriptorDigest ||
        pull.resultSchemaDigest !== claims.resultSchemaDigest
      ) {
        return { status: "rejected", code: "invalid_resolution_capability" };
      }
      if (
        pull.revoked ||
        (claims.attemptId !== "none" && (!attempt || attempt.state === "revoked"))
      ) {
        return { status: "rejected", code: "capability_revoked" };
      }
      if (task.status !== "active") {
        return { status: "rejected", code: "task_terminal" };
      }
      return undefined;
    };
    const preRejection = verifyResolvable();
    if (preRejection) {
      return preRejection;
    }
    let outcome: OperationOutcome;
    try {
      outcome = snapshotOutcome(request.outcome);
    } catch {
      return { status: "rejected", code: "schema_validation_failed" };
    }
    if (outcome.status === "cancelled" && outcome.partial !== undefined) {
      // Cancellation itself never requires payload validation; an unusable
      // partial is durably discarded rather than blocking the cancellation.
      const definition =
        pull.descriptor.kind === "effect" ? task.manifest.effects[pull.descriptor.name] : undefined;
      let reason: "schema_validation_failed" | "payload_too_large" | "schema_version_unavailable";
      let partial: Json | undefined;
      if (!definition?.cancellation) {
        reason = "schema_validation_failed";
      } else {
        const validated = yield* validateRegisteredSchema(
          this.#schemas,
          definition.cancellation.partialSchema.digest,
          outcome.partial,
        );
        if (validated.status === "ok") {
          try {
            assertInlineSize(
              validated.value,
              Math.min(claims.maxOutcomeBytes, pull.maxOutcomeBytes),
            );
            partial = validated.value;
            reason = "schema_validation_failed";
          } catch {
            reason = "payload_too_large";
          }
        } else {
          reason =
            validated.status === "unavailable"
              ? "schema_version_unavailable"
              : "schema_validation_failed";
        }
      }
      const partialRejection = verifyResolvable();
      if (partialRejection) {
        return partialRejection;
      }
      if (partial !== undefined) {
        outcome = { status: "cancelled", partial };
      } else {
        const alreadyDiscarded = (this.#records.get(task.sessionId) ?? []).some(
          (record) =>
            record.payload.type === "CancellationPartialDiscarded" &&
            record.payload.taskId === task.taskId &&
            record.payload.pullId === pull.pullId,
        );
        if (!alreadyDiscarded) {
          this.#append(task.sessionId, undefined, {
            type: "CancellationPartialDiscarded",
            taskId: task.taskId,
            pullId: pull.pullId,
            reason,
          });
        }
        outcome = { status: "cancelled" };
      }
    } else {
      try {
        assertInlineSize(outcome, Math.min(claims.maxOutcomeBytes, pull.maxOutcomeBytes));
      } catch (error) {
        if (error instanceof CrankError && error.code === "payload_too_large") {
          return { status: "rejected", code: "payload_too_large" };
        }
        return { status: "rejected", code: "schema_validation_failed" };
      }
    }
    if (outcome.status === "ok") {
      if (pull.descriptor.kind === "elicit") {
        // One WireElicitResult algebra: accepted content is validated against
        // the declared content schema; decline/cancel keep only bounded safe
        // fields and never run the content validator.
        const envelope = parseWireElicitEnvelope(outcome.value);
        if (!envelope) {
          return { status: "rejected", code: "schema_validation_failed" };
        }
        if (envelope.action === "accept") {
          const validated = yield* validateRegisteredSchema(
            this.#schemas,
            pull.resultSchemaDigest,
            envelope.content,
          );
          if (validated.status === "unavailable") {
            return { status: "rejected", code: "schema_version_unavailable" };
          }
          if (validated.status === "invalid") {
            return { status: "rejected", code: "schema_validation_failed" };
          }
          outcome = { status: "ok", value: { action: "accept", content: validated.value } };
        } else {
          const reason = sanitizeCancellationReason(
            typeof envelope.reason === "string" ? envelope.reason : undefined,
          );
          outcome = {
            status: "ok",
            value: { action: envelope.action, ...(reason !== undefined ? { reason } : {}) },
          };
        }
      } else {
        const validated = yield* validateRegisteredSchema(
          this.#schemas,
          pull.resultSchemaDigest,
          outcome.value,
        );
        if (validated.status === "unavailable") {
          return { status: "rejected", code: "schema_version_unavailable" };
        }
        if (validated.status === "invalid") {
          return { status: "rejected", code: "schema_validation_failed" };
        }
        outcome = { status: "ok", value: validated.value };
      }
    }
    // Registry validators may await; re-verify capability revocation, task
    // state, and digest binding immediately before the append.
    const postRejection = verifyResolvable();
    if (postRejection) {
      return postRejection;
    }
    try {
      assertInlineSize(outcome, Math.min(claims.maxOutcomeBytes, pull.maxOutcomeBytes));
    } catch {
      return { status: "rejected", code: "payload_too_large" };
    }
    if (pull.effectiveDescriptor.kind === "wait" && outcome.status === "ok") {
      const notBefore = pull.effectiveDescriptor.notBefore;
      if (notBefore && this.#options.now() < Date.parse(notBefore)) {
        return { status: "rejected", code: "wait_not_due" };
      }
    }
    const digest = canonicalSnapshot(outcome).sha;
    if (pull.outcome && pull.receipt) {
      if (pull.outcomeDigest === digest) {
        return { status: "duplicate", receipt: { ...pull.receipt, status: "duplicate" } };
      }
      return {
        status: "rejected",
        code: pull.attempts.length > 1 ? "idempotency_conflict" : "resolution_conflict",
      };
    }
    const offset = this.#append(task.sessionId, undefined, {
      type: "PullResolved",
      taskId: task.taskId,
      pullId: pull.pullId,
      ...(attempt ? { attemptId: attempt.attemptId } : {}),
      outcome,
      outcomeDigest: digest,
    });
    if (attempt) {
      attempt.state = "completed";
      for (const competitor of pull.attempts) {
        if (
          competitor === attempt ||
          competitor.state === "revoked" ||
          competitor.state === "superseded"
        ) {
          continue;
        }
        competitor.state = "superseded";
        this.#append(task.sessionId, undefined, {
          type: "AttemptSuperseded",
          taskId: task.taskId,
          pullId: pull.pullId,
          attemptId: competitor.attemptId,
          winnerAttemptId: attempt.attemptId,
        });
      }
    }
    const receipt: ResolutionReceipt = {
      sessionId: task.sessionId,
      taskId: task.taskId,
      pullId: pull.pullId,
      resolutionOffset: offset,
      outcomeDigest: digest,
      status: "accepted",
    };
    pull.outcome = outcome;
    pull.outcomeDigest = digest;
    pull.receipt = receipt;
    task.nextActionIndex = Math.max(task.nextActionIndex, pull.actionIndex + 1);
    if (task.cancellation.type === "settling_effect" && task.cancellation.pullId === pull.pullId) {
      task.cancellation = {
        type: "requested",
        commandId: task.cancellation.commandId,
        ...(task.cancellation.reason !== undefined ? { reason: task.cancellation.reason } : {}),
        frontier: task.cancellation.frontier,
      };
    }
    this.#runnable.add(task.sessionId);
    return { status: "accepted", receipt };
  }

  /** Appends an action-indexed durable emission idempotently. */
  *emit(request: AppendEmissionRequest): Operation<EmissionReceipt> {
    const task = this.#task(request.sessionId, request.taskId);
    this.#assertProgram(request.programCapability, task);
    this.#assertActive(task);
    if (!task.manifest.capabilities.durableEmissions) {
      throw new CrankError("invalid_descriptor", "Program does not declare durable emissions");
    }
    const descriptor = canonicalSnapshot(request.descriptor).value;
    const digest = canonicalSnapshot(descriptor).sha;
    const existing = task.emissionsByAction.get(request.actionIndex);
    if (existing) {
      if (existing.digest !== digest) {
        throw new CrankError("nondeterminism_detected", "Emission payload differs");
      }
      return { ...existing.receipt, duplicate: true };
    }
    if (request.actionIndex !== task.nextActionIndex) {
      throw new CrankError("nondeterminism_detected", "Emission action cursor mismatch");
    }
    assertInlineSize(descriptor.payload, this.#options.maxOutcomeBytes);
    const payloadBytes = canonicalByteLength(descriptor.payload);
    const acceptedCount = task.acceptedEmissionCount ?? task.emissionsByAction.size;
    const cumulativeBytes = task.cumulativeEmissionBytes ?? 0;
    const nextCount = acceptedCount + 1;
    const nextCumulativeBytes = cumulativeBytes + payloadBytes;
    if (
      (task.emissionPolicy?.maxEmissionsPerTask !== undefined &&
        nextCount > task.emissionPolicy.maxEmissionsPerTask) ||
      (task.emissionPolicy?.maxCumulativeEmissionBytes !== undefined &&
        nextCumulativeBytes > task.emissionPolicy.maxCumulativeEmissionBytes)
    ) {
      throw new CrankError("emission_quota_exceeded", "Semantic emission quota exceeded");
    }
    if (request.restoredFrontier) {
      yield* this.#consumeRestoredFrontier(
        request.restoredFrontier,
        request.restoredFrontierStep,
        task,
      );
    }
    const emissionIndex = task.nextEmissionIndex;
    const offset = this.#append(task.sessionId, task.executionEpoch, {
      type: "DurableEmission",
      taskId: task.taskId,
      actionIndex: request.actionIndex,
      emissionIndex,
      descriptor,
      descriptorDigest: digest,
    });
    const receipt: EmissionReceipt = {
      offset,
      eventId: `journal:${task.sessionId}:${offset}`,
      duplicate: false,
      ...(request.restoredFrontier ? { restoredFrontierConsumed: true } : {}),
    };
    task.emissionsByAction.set(request.actionIndex, { digest, receipt });
    task.nextEmissionIndex += 1;
    task.nextActionIndex += 1;
    if (task.emissionPolicy) {
      task.acceptedEmissionCount = nextCount;
      task.cumulativeEmissionBytes = nextCumulativeBytes;
    }
    return receipt;
  }

  /** Closes a task exactly once after validating its manifest output schema. */
  *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
    const task = this.#task(request.sessionId, request.taskId);
    this.#assertProgram(request.programCapability, task);
    const proposedOutcome = snapshotOutcome(request.outcome);
    let outcome: OperationOutcome =
      task.cancellation.type === "unwinding" ? { status: "cancelled" } : proposedOutcome;
    if (outcome.status === "ok") {
      outcome = {
        status: "ok",
        value: yield* this.#validateThroughRegistry(
          task.manifest.outputSchema.digest,
          outcome.value,
          "schema_validation_failed",
        ),
      };
      // Registry validators may await; re-verify authority state before append.
      this.#assertProgram(request.programCapability, task);
      if (task.cancellation.type === "unwinding") {
        outcome = { status: "cancelled" };
      }
    }
    assertInlineSize(outcome, this.#options.maxOutcomeBytes);
    const digest = canonicalSnapshot(outcome).sha;
    if (task.close) {
      if (task.close.digest !== digest) {
        throw new CrankError("nondeterminism_detected", "Task completion differs");
      }
      return { ...task.close.receipt, duplicate: true };
    }
    this.#assertActive(task);
    if (request.actionIndex !== task.nextActionIndex) {
      throw new CrankError("history_not_exhausted");
    }
    if ([...task.pullsByAction.values()].some((pull) => !pull.outcome)) {
      throw new CrankError("history_not_exhausted", "Task has an unresolved pull");
    }
    if (request.restoredFrontier) {
      yield* this.#consumeRestoredFrontier(
        request.restoredFrontier,
        request.restoredFrontierStep,
        task,
      );
    }
    const offset = this.#append(task.sessionId, task.executionEpoch, {
      type: "TaskClosed",
      taskId: task.taskId,
      outcome,
    });
    const receipt: TaskCloseReceipt = {
      offset,
      duplicate: false,
      ...(request.restoredFrontier ? { restoredFrontierConsumed: true } : {}),
    };
    task.close = { digest, receipt };
    task.status = outcome.status === "cancelled" ? "cancelled" : "closed";
    if (outcome.status === "cancelled") {
      const commandId =
        task.cancellation.type !== "none" && task.cancellation.type !== "orphaned"
          ? task.cancellation.commandId
          : stableOpaqueId("cancel-command", [task.sessionId, task.taskId]);
      task.cancellation = { type: "cancelled", commandId };
    }
    return receipt;
  }

  /** Idempotently fixes a cancellation frontier and wakes parked work. */
  *requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId = stableOpaqueId("cancel-command", [sessionId, taskId]),
  ): Operation<CancellationAcknowledgement> {
    const task = this.#task(sessionId, taskId);
    const existing = (this.#records.get(sessionId) ?? []).find(
      (record) =>
        record.payload.type === "CancellationRequested" && record.payload.taskId === taskId,
    );
    if (existing?.payload.type === "CancellationRequested") {
      return {
        accepted: true,
        duplicate: true,
        commandId: existing.payload.commandId,
        ...(existing.payload.reason !== undefined ? { reason: existing.payload.reason } : {}),
        frontier: structuredClone(existing.payload.frontier),
      };
    }
    this.#assertActive(task);

    const frontierPull = task.pullsByAction.get(task.nextActionIndex);
    const frontier = {
      actionIndex: task.nextActionIndex,
      ...(frontierPull ? { pullId: frontierPull.pullId } : {}),
    };
    const safeReason = sanitizeCancellationReason(reason);
    task.cancellation = {
      type: "requested",
      commandId,
      ...(safeReason !== undefined ? { reason: safeReason } : {}),
      frontier,
    };
    this.#append(sessionId, undefined, {
      type: "CancellationRequested",
      taskId,
      commandId,
      ...(safeReason !== undefined ? { reason: safeReason } : {}),
      frontier,
    });
    this.#runnable.add(sessionId);

    if (frontierPull && !frontierPull.outcome) {
      const child =
        frontierPull.descriptor.kind === "invoke"
          ? [...this.#tasks.values()].find(
              (candidate) =>
                candidate.sessionId === sessionId &&
                candidate.parentTaskId === taskId &&
                candidate.parentPullId === frontierPull.pullId &&
                candidate.status === "active",
            )
          : undefined;
      if (child) {
        task.cancellation = {
          type: "cancelling_children",
          commandId,
          childTaskIds: [child.taskId],
          ...(safeReason !== undefined ? { reason: safeReason } : {}),
          frontier,
        };
        yield* this.requestCancellation(
          sessionId,
          child.taskId,
          safeReason,
          `${commandId}:child:${child.taskId}`,
        );
      } else {
        const started = frontierPull.attempts.find((attempt) => attempt.state === "started");
        const live =
          (frontierPull.descriptor.kind === "effect" ||
            frontierPull.descriptor.kind === "record") &&
          started !== undefined &&
          hasLiveDurableEffect(sessionId, taskId, frontierPull.pullId);
        if (live) {
          task.cancellation = {
            type: "settling_effect",
            commandId,
            pullId: frontierPull.pullId,
            ...(safeReason !== undefined ? { reason: safeReason } : {}),
            frontier,
          };
          signalLiveDurableEffect(sessionId, taskId, frontierPull.pullId, safeReason);
        } else {
          this.#cancelNonSettleablePull(task, frontierPull);
        }
      }
    }

    return {
      accepted: true,
      duplicate: false,
      commandId,
      ...(safeReason !== undefined ? { reason: safeReason } : {}),
      frontier,
    };
  }

  /** Detaches a live attempt, settling unsafe work as an indeterminate outcome. */
  *detachAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    reason = "transport_lost",
  ): Operation<void> {
    const task = this.#task(sessionId, taskId);
    const pull = this.#pull(task, pullId);
    this.#detachAttempts(task, pull, reason);
  }

  /** Explicitly revokes an attempt that can no longer produce a valid result. */
  *abandonAttempt(
    sessionId: string,
    taskId: string,
    pullId: string,
    attemptId: string,
    reason = "revoked",
  ): Operation<void> {
    const task = this.#task(sessionId, taskId);
    const pull = this.#pull(task, pullId);
    const attempt = pull.attempts.find((candidate) => candidate.attemptId === attemptId);
    if (!attempt) {
      throw new CrankError("pull_not_found");
    }
    if (attempt.state === "revoked") {
      return;
    }
    if (attempt.state === "completed" || attempt.state === "superseded") {
      throw new CrankError("task_terminal");
    }
    attempt.state = "revoked";
    this.#append(sessionId, undefined, {
      type: "AttemptAbandoned",
      taskId,
      pullId,
      attemptId,
      reason,
    });
  }

  /** Orphans a task whose pinned program cannot be recovered safely. */
  *forceOrphan(
    sessionId: string,
    taskId: string,
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged",
  ): Operation<void> {
    const task = this.#task(sessionId, taskId);
    if (task.status === "orphaned") {
      return;
    }
    this.#assertActive(task);
    for (const pull of task.pullsByAction.values()) {
      if (!pull.outcome) {
        pull.revoked = true;
      }
      for (const attempt of pull.attempts) {
        if (attempt.state === "started" || attempt.state === "detached") {
          attempt.state = "revoked";
          if (!pull.outcome) {
            this.#append(sessionId, undefined, {
              type: "AttemptOutcomeUnknown",
              taskId,
              pullId: pull.pullId,
              attemptId: attempt.attemptId,
              reason: "force_orphaned",
            });
          }
        }
      }
    }
    this.#append(sessionId, undefined, { type: "CleanupSkipped", taskId, reason });
    this.#append(sessionId, undefined, { type: "TaskOrphaned", taskId, reason });
    task.status = "orphaned";
    task.cancellation = { type: "orphaned", reason };
  }

  /** Returns the current pull capability for an external resolver. */
  resolutionCapability(sessionId: string, taskId: string, pullId: string): string {
    const task = this.#task(sessionId, taskId);
    const pull = this.#pull(task, pullId);
    if (!pull.capability) {
      pull.capability = this.#resolutionCapability(task, pull, undefined);
    }
    return pull.capability;
  }

  /** Returns a defensive copy of one session's semantic journal. */
  readJournal(sessionId: string): DurableSemanticRecord[] {
    return structuredClone(this.#records.get(sessionId) ?? []);
  }

  /** Reads only one root Structured Execution Tree, excluding completed sibling Turns. */
  readTaskJournal(sessionId: string, rootTaskId: string): DurableSemanticRecord[] {
    const records = this.#records.get(sessionId) ?? [];
    const taskIds = new Set([rootTaskId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const record of records) {
        if (
          record.payload.type === "TaskOpened" &&
          record.payload.parentTaskId &&
          taskIds.has(record.payload.parentTaskId) &&
          !taskIds.has(record.payload.taskId)
        ) {
          taskIds.add(record.payload.taskId);
          changed = true;
        }
      }
    }
    return structuredClone(
      records.filter((record) =>
        "taskId" in record.payload ? taskIds.has(record.payload.taskId) : false,
      ),
    );
  }

  /** Exports a defensive, versioned snapshot for persistence. */
  exportSnapshot(): DurableAuthoritySnapshot {
    const tasks: TaskSnapshot[] = [...this.#tasks.values()].map((task) => ({
      sessionId: task.sessionId,
      turnId: task.turnId,
      taskId: task.taskId,
      manifest: task.manifest,
      input: task.input,
      executionEpoch: task.executionEpoch,
      attachmentId: task.attachmentId,
      audience: task.audience,
      nextActionIndex: task.nextActionIndex,
      nextPullIndex: task.nextPullIndex,
      nextEmissionIndex: task.nextEmissionIndex,
      pullsByAction: [...task.pullsByAction.entries()],
      emissionsByAction: [...task.emissionsByAction.entries()],
      ...(task.emissionPolicy
        ? {
            emissionPolicy: task.emissionPolicy,
            acceptedEmissionCount: task.acceptedEmissionCount ?? 0,
            cumulativeEmissionBytes: task.cumulativeEmissionBytes ?? 0,
          }
        : {}),
      status: task.status,
      cancellation: task.cancellation,
      ...(task.close ? { close: task.close } : {}),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ...(task.parentPullId ? { parentPullId: task.parentPullId } : {}),
      ...(task.catalog
        ? { catalog: structuredClone(task.catalog), catalogDigest: task.catalogDigest! }
        : {}),
      ...(task.route ? { route: structuredClone(task.route) } : {}),
    }));
    return {
      version: 4,
      tasks: structuredClone(tasks),
      records: structuredClone([...this.#records.entries()]),
      runnable: [...this.#runnable],
      nonce: this.#nonce,
      activationLeases: structuredClone([...this.#activationLeases.entries()]),
      lastActivationEpochBySession: [...this.#lastActivationEpochBySession.entries()],
      taskRevisions: [...this.#taskRevisions.entries()],
      restoreNonces: [...this.#restoreNonces.entries()],
      restoreFrontierDigests: [...this.#restoreFrontierDigests.entries()],
      consecutiveRestoreStales: [...this.#consecutiveRestoreStales.entries()],
      activationNotBeforeMs: [...this.#activationNotBeforeMs.entries()],
    };
  }

  /** Canonical parsed input accepted at task open; schema code is not rerun. */
  *taskInput(sessionId: string, taskId: string): Operation<Json> {
    return structuredClone(this.#task(sessionId, taskId).input);
  }

  /** Exact schema digests referenced by nonterminal tasks for deployment reconciliation. */
  *nonterminalSchemaDigests(): Operation<string[]> {
    const digests = new Set<string>();
    for (const task of this.#tasks.values()) {
      if (task.status !== "active") {
        continue;
      }
      for (const digest of manifestSchemaDigests(task.manifest)) {
        digests.add(digest);
      }
      for (const pull of task.pullsByAction.values()) {
        if (!pull.outcome) {
          digests.add(pull.resultSchemaDigest);
        }
      }
    }
    return sortedStrings(digests);
  }

  /** Returns runnable session IDs in deterministic lexical order. */
  runnableSessions(): string[] {
    return sortedStrings(this.#runnable);
  }

  /** Clears a session's runnable marker when an accepted activation starts. */
  /** Returns work recoverable from durable runnable state or an expired owner. */
  *recoverableSessions(): Operation<RecoverableSession[]> {
    const now = this.#options.now();
    const sessions = new Map<string, RecoverableSession>();
    for (const sessionId of this.#runnable) {
      const notBeforeMs = this.#activationNotBeforeMs.get(sessionId);
      if (notBeforeMs === undefined || now >= notBeforeMs) {
        sessions.set(sessionId, { sessionId, reason: "runnable" });
      }
    }
    for (const [sessionId, lease] of this.#activationLeases) {
      if (now >= lease.expiresAtMs) {
        sessions.set(sessionId, { sessionId, reason: "expired_activation" });
      }
    }
    return [...sessions.values()].sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
  }

  /** Claims runnable work with one authority-time lease and monotonically increasing epoch. */
  *claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult> {
    if (!request.sessionId || !request.ownerId) {
      throw new CrankError("invalid_command", "Activation session and owner are required");
    }
    const duration = request.leaseDurationMs ?? 30_000;
    if (!Number.isInteger(duration) || duration < 1_000 || duration > 300_000) {
      throw new CrankError("invalid_command", "Activation lease duration is out of bounds");
    }
    const now = this.#options.now();
    const notBefore = this.#activationNotBeforeMs.get(request.sessionId) ?? 0;
    if (now < notBefore) {
      return { status: "busy", retryAfterMs: notBefore - now };
    }
    const current = this.#activationLeases.get(request.sessionId);
    if (current && now < current.expiresAtMs) {
      return { status: "busy", retryAfterMs: current.expiresAtMs - now };
    }
    const expiredTakeover = current !== undefined && now >= current.expiresAtMs;
    if (!this.#runnable.has(request.sessionId) && !expiredTakeover) {
      return { status: "not_runnable" };
    }
    const epoch = (this.#lastActivationEpochBySession.get(request.sessionId) ?? 0) + 1;
    this.#lastActivationEpochBySession.set(request.sessionId, epoch);
    for (const task of this.#tasks.values()) {
      if (task.sessionId === request.sessionId && task.status === "active") {
        task.executionEpoch = epoch;
      }
    }
    const taskRevision = this.#taskRevisions.get(request.sessionId) ?? 0;
    const journalHeadDigest = this.#journalHeadDigest(request.sessionId);
    const restoreNonce = this.#nextNonce();
    this.#restoreNonces.set(request.sessionId, restoreNonce);
    this.#activationLeases.set(request.sessionId, {
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      epoch,
      expiresAtMs: now + duration,
      leaseDurationMs: duration,
      claimedTaskRevision: taskRevision,
      claimedHeadDigest: journalHeadDigest,
      restoreNonce,
    });
    this.#runnable.delete(request.sessionId);
    return {
      status: "claimed",
      epoch,
      expiresAtMs: now + duration,
      taskRevision,
      journalHeadDigest,
    };
  }

  /** Renews only a current, unexpired owner; equality with expiry is stale. */
  *renewActivation(request: RenewActivationRequest): Operation<RenewActivationResult> {
    const now = this.#options.now();
    const current = this.#activationLeases.get(request.sessionId);
    if (
      !current ||
      current.ownerId !== request.ownerId ||
      current.epoch !== request.epoch ||
      now >= current.expiresAtMs
    ) {
      return { status: "stale_activation" };
    }
    const expiresAtMs = now + current.leaseDurationMs;
    this.#activationLeases.set(request.sessionId, { ...current, expiresAtMs });
    return { status: "renewed", expiresAtMs };
  }

  /** Releases exact ownership and preserves any command that raced the activation. */
  *releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult> {
    const current = this.#activationLeases.get(request.sessionId);
    if (!current || current.ownerId !== request.ownerId || current.epoch !== request.epoch) {
      return { status: "stale_activation" };
    }
    this.#activationLeases.delete(request.sessionId);
    const retryable = ["failed", "scope_exit", "lease_lost"].includes(request.reason);
    // Journal mutations performed by this owner do not themselves imply a
    // wakeup (for example publishing a new unresolved elicit). External command
    // lanes atomically set #runnable, so preserving that winning marker is the
    // exact no-lost-wakeup re-derivation.
    const runnable =
      request.reason !== "terminal" && (retryable || this.#runnable.has(request.sessionId));
    if (runnable) {
      this.#runnable.add(request.sessionId);
    } else {
      this.#runnable.delete(request.sessionId);
    }
    return { status: "released", runnable };
  }

  /** Issues one authenticated host-private ticket for the current claimed snapshot. */
  *issueRestoreTicket(request: IssueRestoreTicketRequest): Operation<IssueRestoreTicketResult> {
    const lease = this.#activationLeases.get(request.sessionId);
    const now = this.#options.now();
    if (
      !lease ||
      lease.ownerId !== request.ownerId ||
      lease.epoch !== request.activationEpoch ||
      now >= lease.expiresAtMs
    ) {
      throw new CrankError("stale_activation");
    }
    this.#task(request.sessionId, request.taskId);
    const restoreNonce = this.#nextNonce();
    this.#restoreNonces.set(request.sessionId, restoreNonce);
    this.#activationLeases.set(request.sessionId, { ...lease, restoreNonce });
    const claims: RestoreTicketClaims = {
      version: 1,
      journalId: this.#options.journalId,
      journalIncarnation: this.#options.journalIncarnation,
      sessionId: request.sessionId,
      taskId: request.taskId,
      ownerId: request.ownerId,
      activationEpoch: request.activationEpoch,
      taskRevision: this.#taskRevisions.get(request.sessionId) ?? 0,
      journalHeadDigest: this.#journalHeadDigest(request.sessionId),
      replayedThroughActionIndex: request.replayedThroughActionIndex,
      replayChainDigest: request.replayChainDigest,
      restoreNonce,
    };
    return {
      restoreTicket: signPrivateAuthorityToken("restore-ticket", claims, this.#options.keyring),
      taskRevision: claims.taskRevision,
      journalHeadDigest: claims.journalHeadDigest,
    };
  }

  /** Derives an integrity-linked replay plan and ticket from one claimed snapshot. */
  *prepareProgramRestore(request: PrepareProgramRestoreRequest): Operation<PreparedProgramRestore> {
    const lease = this.#activationLeases.get(request.sessionId);
    const now = this.#options.now();
    if (
      !lease ||
      lease.ownerId !== request.ownerId ||
      lease.epoch !== request.activationEpoch ||
      now >= lease.expiresAtMs
    ) {
      throw new CrankError("stale_activation");
    }
    const task = this.#task(request.sessionId, request.taskId);
    if (task.executionEpoch !== request.activationEpoch) {
      throw new CrankError("stale_activation");
    }
    const taskRevision = this.#taskRevisions.get(request.sessionId) ?? 0;
    const journalHeadDigest = this.#journalHeadDigest(request.sessionId);
    const restoreNonce = this.#nextNonce();
    const replayChainSeed = sha256(
      canonicalJson({
        domain: request.replayDomain,
        protocolVersion: 1,
        releaseId: request.releaseId,
        sessionId: request.sandboxSessionId,
        taskId: request.taskId,
        program: {
          id: task.manifest.programId,
          version: task.manifest.version,
          digest: task.manifest.digest,
        },
        activationEpoch: request.activationEpoch,
        journalHeadDigest,
        restoreNonce,
      }),
    );
    const replay: ReplayEntry[] = [];
    let previousEntryDigest = replayChainSeed;
    let replayedThroughActionIndex = -1;
    for (let actionIndex = 0; actionIndex < task.nextActionIndex; actionIndex += 1) {
      const pull = task.pullsByAction.get(actionIndex);
      const emission = task.emissionsByAction.get(actionIndex);
      let entryWithoutEntryDigest:
        | Omit<ReplayOperationEntry, "entryDigest">
        | Omit<ReplayEmissionEntry, "entryDigest">;
      if (pull?.outcome && pull.receipt) {
        entryWithoutEntryDigest = {
          type: "operation",
          actionIndex,
          descriptorKind: pull.descriptor.kind,
          descriptorDigest: pull.descriptorDigest,
          previousEntryDigest,
          outcome: structuredClone(pull.outcome),
          receipt: structuredClone(pull.receipt),
        };
      } else if (emission) {
        entryWithoutEntryDigest = {
          type: "emission",
          actionIndex,
          descriptorKind: "emission",
          descriptorDigest: emission.digest,
          previousEntryDigest,
          offset: emission.receipt.offset,
        };
      } else {
        throw new CrankError("invalid_journal", "Replay history has an action gap");
      }
      const entryDigest = sha256(
        canonicalJson({
          replayChainSeed,
          previousEntryDigest,
          entryWithoutEntryDigest,
        }),
      );
      replay.push({ ...entryWithoutEntryDigest, entryDigest } as ReplayEntry);
      previousEntryDigest = entryDigest;
      replayedThroughActionIndex = actionIndex;
    }
    this.#restoreNonces.set(request.sessionId, restoreNonce);
    this.#restoreFrontierDigests.delete(request.sessionId);
    this.#activationLeases.set(request.sessionId, { ...lease, restoreNonce });
    const claims: RestoreTicketClaims = {
      version: 1,
      journalId: this.#options.journalId,
      journalIncarnation: this.#options.journalIncarnation,
      sessionId: request.sessionId,
      taskId: request.taskId,
      ownerId: request.ownerId,
      activationEpoch: request.activationEpoch,
      releaseId: request.releaseId,
      sandboxSessionId: request.sandboxSessionId,
      replayDomain: request.replayDomain,
      frontierDomain: request.frontierDomain,
      taskRevision,
      journalHeadDigest,
      replayedThroughActionIndex,
      replayChainDigest: previousEntryDigest,
      restoreNonce,
    };
    return {
      restoreTicket: signPrivateAuthorityToken("restore-ticket", claims, this.#options.keyring),
      replay,
      replayedThroughActionIndex,
      replayChainSeed,
      replayChainDigest: previousEntryDigest,
      taskRevision,
      journalHeadDigest,
    };
  }

  /** Binds the independently verified remote frontier digest to the pending ticket. */
  *bindRestoreFrontier(request: BindRestoreFrontierRequest): Operation<BindRestoreFrontierResult> {
    let claims: RestoreTicketClaims;
    try {
      claims = parseRestoreTicketClaims(
        verifyPrivateAuthorityToken(request.restoreTicket, "restore-ticket", this.#options.keyring),
      );
    } catch {
      return { status: "restore_stale" };
    }
    const lease = this.#activationLeases.get(request.sessionId);
    if (
      !/^[0-9a-f]{64}$/.test(request.frontierDigest) ||
      !lease ||
      this.#options.now() >= lease.expiresAtMs ||
      lease.ownerId !== request.ownerId ||
      lease.epoch !== request.activationEpoch ||
      claims.sessionId !== request.sessionId ||
      claims.taskId !== request.taskId ||
      claims.ownerId !== request.ownerId ||
      claims.activationEpoch !== request.activationEpoch ||
      claims.taskRevision !== (this.#taskRevisions.get(request.sessionId) ?? 0) ||
      claims.journalHeadDigest !== this.#journalHeadDigest(request.sessionId) ||
      claims.restoreNonce !== this.#restoreNonces.get(request.sessionId)
    ) {
      return { status: "restore_stale" };
    }
    this.#restoreFrontierDigests.set(request.sessionId, request.frontierDigest);
    return {
      status: "bound",
      proof: {
        restoreTicket: request.restoreTicket,
        frontierDigest: request.frontierDigest,
      },
    };
  }

  /** Verifies and atomically consumes a single-use restored-frontier ticket. */
  *consumeRestoreTicket(
    request: ConsumeRestoreTicketRequest,
  ): Operation<ConsumeRestoreTicketResult> {
    let claims: RestoreTicketClaims | undefined;
    try {
      claims = parseRestoreTicketClaims(
        verifyPrivateAuthorityToken(
          request.proof.restoreTicket,
          "restore-ticket",
          this.#options.keyring,
        ),
      );
    } catch {
      return this.#recordRestoreStale(request.sessionId);
    }
    const lease = this.#activationLeases.get(request.sessionId);
    const valid =
      /^[0-9a-f]{64}$/.test(request.proof.frontierDigest) &&
      claims.journalId === this.#options.journalId &&
      claims.journalIncarnation === this.#options.journalIncarnation &&
      claims.sessionId === request.sessionId &&
      claims.taskId === request.taskId &&
      claims.ownerId === request.ownerId &&
      claims.activationEpoch === request.activationEpoch &&
      lease?.ownerId === request.ownerId &&
      lease.epoch === request.activationEpoch &&
      this.#options.now() < lease.expiresAtMs &&
      claims.taskRevision === (this.#taskRevisions.get(request.sessionId) ?? 0) &&
      claims.journalHeadDigest === this.#journalHeadDigest(request.sessionId) &&
      claims.restoreNonce === this.#restoreNonces.get(request.sessionId) &&
      request.proof.frontierDigest === this.#restoreFrontierDigests.get(request.sessionId);
    if (!valid) {
      return this.#recordRestoreStale(request.sessionId);
    }
    const consumedNonce = this.#nextNonce();
    this.#restoreNonces.set(request.sessionId, consumedNonce);
    this.#restoreFrontierDigests.delete(request.sessionId);
    this.#activationLeases.set(request.sessionId, { ...lease, restoreNonce: consumedNonce });
    this.#consecutiveRestoreStales.delete(request.sessionId);
    this.#activationNotBeforeMs.delete(request.sessionId);
    return { status: "consumed" };
  }

  /** Returns a defensive cancellation-state snapshot for fresh replay. */
  *cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState> {
    return structuredClone(this.#task(sessionId, taskId).cancellation);
  }

  /** Begins one-shot authored unwind after the fixed frontier has settled. */
  *beginCancellationUnwind(
    sessionId: string,
    taskId: string,
    restoredFrontier?: { readonly proof: RestoredFrontierProof; readonly step: ProgramStep },
  ): Operation<DurableCancellationState> {
    const task = this.#task(sessionId, taskId);
    const current = task.cancellation;
    if (current.type === "unwinding" || current.type === "cancelled") {
      return structuredClone(current);
    }
    if (
      current.type !== "requested" &&
      current.type !== "settling_effect" &&
      current.type !== "cancelling_children"
    ) {
      throw new CrankError("invalid_command", "Task has no cancellation to unwind");
    }
    const frontierPull = current.frontier.pullId
      ? [...task.pullsByAction.values()].find((pull) => pull.pullId === current.frontier.pullId)
      : undefined;
    if (frontierPull && !frontierPull.outcome) {
      throw new CrankError("cancellation_blocked", "Cancellation frontier has not settled");
    }
    if (restoredFrontier) {
      yield* this.#consumeRestoredFrontier(restoredFrontier.proof, restoredFrontier.step, task);
    }
    task.cancellation = {
      type: "unwinding",
      commandId: current.commandId,
      ...(current.reason !== undefined ? { reason: current.reason } : {}),
      frontier: current.frontier,
    };
    return structuredClone(task.cancellation);
  }

  #assertEffectContractsCompatible(manifest: DurableProgramManifest): void {
    const retained = new Map<string, string>();
    for (const task of this.#tasks.values()) {
      for (const definition of Object.values(task.manifest.effects)) {
        const key = effectContractKey(definition.name, definition.version);
        const digest = effectContractDigest(definition);
        const existing = retained.get(key);
        if (existing !== undefined && existing !== digest) {
          throw new CrankError(
            "invalid_manifest",
            `Retained effect contract differs for ${definition.name}@${definition.version}`,
          );
        }
        retained.set(key, digest);
      }
    }
    for (const definition of Object.values(manifest.effects)) {
      const key = effectContractKey(definition.name, definition.version);
      const digest = effectContractDigest(definition);
      const existing = retained.get(key);
      if (existing !== undefined && existing !== digest) {
        throw new CrankError(
          "invalid_manifest",
          `Effect contract differs for ${definition.name}@${definition.version}`,
        );
      }
      retained.set(key, digest);
    }
  }

  #restore(snapshot: DurableAuthoritySnapshot): void {
    if (
      snapshot.version !== 4 ||
      !Array.isArray(snapshot.tasks) ||
      !Array.isArray(snapshot.records)
    ) {
      throw new CrankError("invalid_journal", "Invalid durable authority snapshot");
    }
    this.#tasks.clear();
    this.#records.clear();
    this.#runnable.clear();
    this.#activationLeases.clear();
    this.#lastActivationEpochBySession.clear();
    this.#taskRevisions.clear();
    this.#restoreNonces.clear();
    this.#restoreFrontierDigests.clear();
    this.#consecutiveRestoreStales.clear();
    this.#activationNotBeforeMs.clear();
    for (const value of snapshot.tasks) {
      const task: Task = {
        ...structuredClone(value),
        pullsByAction: new Map(structuredClone(value.pullsByAction)),
        emissionsByAction: new Map(structuredClone(value.emissionsByAction)),
      };
      this.#tasks.set(taskKey(task.sessionId, task.taskId), task);
    }
    for (const [sessionId, records] of snapshot.records) {
      this.#records.set(sessionId, structuredClone(records));
    }
    for (const task of this.#tasks.values()) {
      if (!task.emissionPolicy) {
        continue;
      }
      const emissions = (this.#records.get(task.sessionId) ?? []).filter(
        (record) =>
          record.payload.type === "DurableEmission" && record.payload.taskId === task.taskId,
      );
      const cumulativeBytes = emissions.reduce(
        (total, record) =>
          total +
          (record.payload.type === "DurableEmission"
            ? canonicalByteLength(record.payload.descriptor.payload)
            : 0),
        0,
      );
      if (
        task.acceptedEmissionCount !== emissions.length ||
        task.cumulativeEmissionBytes !== cumulativeBytes
      ) {
        throw new CrankError("invalid_journal", "Semantic emission counters differ from records");
      }
    }
    for (const sessionId of snapshot.runnable) {
      this.#runnable.add(sessionId);
    }
    for (const [sessionId, lease] of snapshot.activationLeases) {
      this.#activationLeases.set(sessionId, structuredClone(lease));
    }
    for (const entry of snapshot.lastActivationEpochBySession) {
      this.#lastActivationEpochBySession.set(...entry);
    }
    for (const entry of snapshot.taskRevisions) {
      this.#taskRevisions.set(...entry);
    }
    for (const entry of snapshot.restoreNonces) {
      this.#restoreNonces.set(...entry);
    }
    for (const entry of snapshot.restoreFrontierDigests) {
      this.#restoreFrontierDigests.set(...entry);
    }
    for (const entry of snapshot.consecutiveRestoreStales) {
      this.#consecutiveRestoreStales.set(...entry);
    }
    for (const entry of snapshot.activationNotBeforeMs) {
      this.#activationNotBeforeMs.set(...entry);
    }
    this.#nonce = snapshot.nonce;
  }

  #authorizeExisting(task: Task, pull: Pull): ReserveOperationResult {
    let active: Attempt | undefined;
    for (let index = pull.attempts.length - 1; index >= 0; index -= 1) {
      const candidate = pull.attempts[index];
      if (candidate?.state === "started") {
        active = candidate;
        break;
      }
    }
    if (active) {
      return this.#authorizedAttempt(task, pull, active.attemptId, active.capability);
    }
    return this.#startAttempt(task, pull);
  }

  #startAttempt(task: Task, pull: Pull): Extract<ReserveOperationResult, { status: "authorized" }> {
    const attemptIndex = pull.attempts.length;
    const attemptId = `${pull.pullId}:attempt-${attemptIndex}`;
    const capability = this.#resolutionCapability(task, pull, attemptId);
    const attempt: Attempt = { attemptId, attemptIndex, state: "started", capability };
    pull.attempts.push(attempt);
    this.#append(task.sessionId, task.executionEpoch, {
      type: "AttemptStarted",
      taskId: task.taskId,
      pullId: pull.pullId,
      attemptId,
      attemptIndex,
    });
    return this.#authorizedAttempt(task, pull, attemptId, capability);
  }

  #authorizedAttempt(
    task: Task,
    pull: Pull,
    attemptId: string,
    resolutionCapability: string,
  ): Extract<ReserveOperationResult, { status: "authorized" }> {
    const descriptor = installedOrRecordedDescriptor(pull.effectiveDescriptor);
    return {
      status: "authorized",
      pullId: pull.pullId,
      attemptId,
      descriptor,
      ...(descriptor.kind === "effect"
        ? {
            effectContractDigest: effectDigestForPull(task, pull),
            effectDefinition: structuredClone(task.manifest.effects[descriptor.name]!),
          }
        : {}),
      resolutionCapability,
    };
  }

  #cancelNonSettleablePull(task: Task, pull: Pull): void {
    pull.revoked = true;
    let uncertainAttempt: Attempt | undefined;
    for (const attempt of pull.attempts) {
      if (attempt.state === "completed" || attempt.state === "superseded") {
        continue;
      }
      if (attempt.state === "detached" || attempt.state === "started") {
        uncertainAttempt ??= attempt;
      }
      attempt.state = "revoked";
    }
    if (uncertainAttempt) {
      this.#append(task.sessionId, undefined, {
        type: "AttemptOutcomeUnknown",
        taskId: task.taskId,
        pullId: pull.pullId,
        attemptId: uncertainAttempt.attemptId,
        reason: "no_settlement_path",
      });
    }
    const outcome: OperationOutcome = { status: "cancelled" };
    const digest = canonicalSnapshot(outcome).sha;
    const offset = this.#append(task.sessionId, undefined, {
      type: "PullResolved",
      taskId: task.taskId,
      pullId: pull.pullId,
      outcome,
      outcomeDigest: digest,
    });
    const receipt: ResolutionReceipt = {
      sessionId: task.sessionId,
      taskId: task.taskId,
      pullId: pull.pullId,
      resolutionOffset: offset,
      outcomeDigest: digest,
      status: "accepted",
    };
    pull.outcome = outcome;
    pull.outcomeDigest = digest;
    pull.receipt = receipt;
    task.nextActionIndex = Math.max(task.nextActionIndex, pull.actionIndex + 1);
  }

  #detachAttempts(task: Task, pull: Pull, reason: string): void {
    for (const attempt of pull.attempts) {
      if (attempt.state !== "started") {
        continue;
      }
      attempt.state = "detached";
      this.#append(task.sessionId, undefined, {
        type: "AttemptDetached",
        taskId: task.taskId,
        pullId: pull.pullId,
        attemptId: attempt.attemptId,
        reason,
      });
      if (pull.descriptor.kind === "effect" || pull.descriptor.kind === "record") {
        const retrySafety =
          pull.descriptor.kind === "effect"
            ? task.manifest.effects[pull.descriptor.name]?.retrySafety
            : pull.descriptor.retrySafety;
        if (retrySafety?.mode === "unsafe") {
          // The attempt is gone and no resolver can prove what happened. Record
          // the uncertainty, then settle it as a coded outcome so the authored
          // program can decide. Keeping the pull open would only be sound if a
          // capability holder survived the host, which none currently does.
          this.#append(task.sessionId, undefined, {
            type: "PullIndeterminate",
            taskId: task.taskId,
            pullId: pull.pullId,
            attemptId: attempt.attemptId,
          });
          this.#failIndeterminatePull(task, pull, attempt, reason);
        }
      }
    }
  }

  /**
   * Settles an unsafe detached effect as a replayable application failure.
   * The detached attempt is revoked before the outcome is published so a late
   * resolver cannot race the configured fail-closed policy.
   */
  #failIndeterminatePull(task: Task, pull: Pull, attempt: Attempt, reason: string): void {
    attempt.state = "revoked";
    this.#append(task.sessionId, undefined, {
      type: "AttemptAbandoned",
      taskId: task.taskId,
      pullId: pull.pullId,
      attemptId: attempt.attemptId,
      reason: "indeterminate_fail",
    });
    const outcome: OperationOutcome = {
      status: "error",
      error: {
        code: "effect_outcome_indeterminate",
        message: "Unsafe effect outcome became indeterminate",
        details: {
          pullId: pull.pullId,
          attemptId: attempt.attemptId,
          reason: sanitizeCancellationReason(reason) ?? "detached",
        },
      },
    };
    assertInlineSize(outcome, pull.maxOutcomeBytes);
    const outcomeDigest = canonicalSnapshot(outcome).sha;
    const resolutionOffset = this.#append(task.sessionId, undefined, {
      type: "PullResolved",
      taskId: task.taskId,
      pullId: pull.pullId,
      attemptId: attempt.attemptId,
      outcome,
      outcomeDigest,
    });
    pull.outcome = outcome;
    pull.outcomeDigest = outcomeDigest;
    pull.receipt = {
      sessionId: task.sessionId,
      taskId: task.taskId,
      pullId: pull.pullId,
      resolutionOffset,
      outcomeDigest,
      status: "accepted",
    };
    task.nextActionIndex = Math.max(task.nextActionIndex, pull.actionIndex + 1);
    if (task.cancellation.type === "settling_effect" && task.cancellation.pullId === pull.pullId) {
      task.cancellation = {
        type: "requested",
        commandId: task.cancellation.commandId,
        ...(task.cancellation.reason !== undefined ? { reason: task.cancellation.reason } : {}),
        frontier: task.cancellation.frontier,
      };
    }
    this.#runnable.add(task.sessionId);
  }

  #programCapability(task: Task): string {
    return signCapability(
      {
        journalId: this.#options.journalId,
        journalIncarnation: this.#options.journalIncarnation,
        sessionId: task.sessionId,
        taskId: task.taskId,
        programId: task.manifest.programId,
        programVersion: task.manifest.version,
        programDigest: task.manifest.digest,
        attachmentId: task.attachmentId,
        executionEpoch: task.executionEpoch,
        audience: task.audience,
        permissions: ["propose", "complete"],
        nonce: this.#nextNonce(),
      },
      this.#options.keyring,
    );
  }

  #resolutionCapability(task: Task, pull: Pull, attemptId: string | undefined): string {
    return signCapability(
      {
        journalId: this.#options.journalId,
        journalIncarnation: this.#options.journalIncarnation,
        sessionId: task.sessionId,
        taskId: task.taskId,
        pullId: pull.pullId,
        descriptorDigest: pull.descriptorDigest,
        resultSchemaDigest: pull.resultSchemaDigest,
        attemptId: attemptId ?? "none",
        audience: pull.audience,
        permissions: ["resolve"],
        maxOutcomeBytes: pull.maxOutcomeBytes,
        nonce: this.#nextNonce(),
      },
      this.#options.keyring,
    );
  }

  #assertProgram(token: string, task: Task): void {
    const claims = verifyProgramCapability(token, this.#options.keyring, {
      audience: task.audience,
      journalId: this.#options.journalId,
      journalIncarnation: this.#options.journalIncarnation,
      sessionId: task.sessionId,
      taskId: task.taskId,
      executionEpoch: task.executionEpoch,
      attachmentId: task.attachmentId,
    });
    if (
      claims.programId !== task.manifest.programId ||
      claims.programVersion !== task.manifest.version ||
      claims.programDigest !== task.manifest.digest
    ) {
      throw new CrankError("program_version_mismatch");
    }
  }

  #closedOutcome(sessionId: string, taskId: string): OperationOutcome | undefined {
    const records = this.#records.get(sessionId) ?? [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const payload = records[index]?.payload;
      if (payload?.type === "TaskClosed" && payload.taskId === taskId) {
        return payload.outcome;
      }
    }
    return undefined;
  }

  #task(sessionId: string, taskId: string): Task {
    const task = this.#tasks.get(taskKey(sessionId, taskId));
    if (!task) {
      throw new CrankError("unknown_target", `Unknown task ${taskId}`);
    }
    return task;
  }

  #pull(task: Task, pullId: string): Pull {
    const pull = [...task.pullsByAction.values()].find((candidate) => candidate.pullId === pullId);
    if (!pull) {
      throw new CrankError("pull_not_found");
    }
    return pull;
  }

  #assertActive(task: Task): void {
    if (task.status !== "active") {
      throw new CrankError("task_terminal");
    }
  }

  /** Validates through the digest-selected registry validator, throwing on failure. */
  *#validateThroughRegistry(digest: string, value: unknown, errorCode: string): Operation<Json> {
    const validated: RegistrySchemaValidation = yield* validateRegisteredSchema(
      this.#schemas,
      digest,
      value,
    );
    if (validated.status === "unavailable") {
      throw new CrankError(
        "schema_version_unavailable",
        `No retained validator bundle for schema digest ${digest}`,
      );
    }
    if (validated.status === "invalid") {
      throw new CrankError(errorCode, "Schema validation failed", {
        issues: validated.issues.map((issue) => ({
          message: issue.message,
          ...(issue.path !== undefined ? { path: issue.path } : {}),
        })),
      });
    }
    return validated.value;
  }

  #append(
    sessionId: string,
    ownerEpoch: number | undefined,
    payload: DurableSemanticRecord["payload"],
  ): string {
    const records = this.#records.get(sessionId) ?? [];
    const offset = String(records.length);
    records.push({
      offset,
      eventId: `journal:${sessionId}:${offset}`,
      sessionId,
      ...(ownerEpoch !== undefined ? { ownerEpoch } : {}),
      payload: structuredClone(payload),
    });
    this.#records.set(sessionId, records);
    this.#taskRevisions.set(sessionId, (this.#taskRevisions.get(sessionId) ?? 0) + 1);
    return offset;
  }

  *#consumeRestoredFrontier(
    proof: NonNullable<ReserveOperationRequest["restoredFrontier"]>,
    frontier: ProgramStep | undefined,
    task: Task,
  ): Operation<void> {
    const lease = this.#activationLeases.get(task.sessionId);
    if (!lease || !frontier) {
      throw new CrankError("restore_stale");
    }
    let claims: RestoreTicketClaims;
    try {
      claims = parseRestoreTicketClaims(
        verifyPrivateAuthorityToken(proof.restoreTicket, "restore-ticket", this.#options.keyring),
      );
    } catch {
      throw new CrankError("restore_stale");
    }
    if (!claims.releaseId || !claims.frontierDomain) {
      throw new CrankError("restore_stale");
    }
    const expectedFrontierDigest = sha256(
      canonicalJson({
        domain: claims.frontierDomain,
        protocolVersion: 1,
        releaseId: claims.releaseId,
        taskId: task.taskId,
        activationEpoch: task.executionEpoch,
        replayedThroughActionIndex: claims.replayedThroughActionIndex,
        replayChainDigest: claims.replayChainDigest,
        step: frontier,
      }),
    );
    if (proof.frontierDigest !== expectedFrontierDigest) {
      const stale = this.#recordRestoreStale(task.sessionId);
      throw new CrankError("restore_stale", "Restored frontier digest differs", {
        consecutiveStales: stale.consecutiveStales,
        retryAfterMs: stale.retryAfterMs,
        releaseRequired: stale.releaseRequired,
      });
    }
    const result = yield* this.consumeRestoreTicket({
      sessionId: task.sessionId,
      taskId: task.taskId,
      ownerId: lease.ownerId,
      activationEpoch: task.executionEpoch,
      proof,
    });
    if (result.status === "restore_stale") {
      throw new CrankError("restore_stale", "Restored frontier is stale", {
        consecutiveStales: result.consecutiveStales,
        retryAfterMs: result.retryAfterMs,
        releaseRequired: result.releaseRequired,
      });
    }
  }

  #journalHeadDigest(sessionId: string): string {
    return canonicalSnapshot(this.#records.get(sessionId) ?? []).sha;
  }

  #recordRestoreStale(
    sessionId: string,
  ): Extract<ConsumeRestoreTicketResult, { status: "restore_stale" }> {
    this.#restoreFrontierDigests.delete(sessionId);
    const count = (this.#consecutiveRestoreStales.get(sessionId) ?? 0) + 1;
    this.#consecutiveRestoreStales.set(sessionId, count);
    if (count < 3) {
      return {
        status: "restore_stale",
        consecutiveStales: count,
        retryAfterMs: 0,
        releaseRequired: false,
      };
    }
    const retryAfterMs = Math.min(250 * 2 ** (count - 3), 5_000);
    this.#activationNotBeforeMs.set(sessionId, this.#options.now() + retryAfterMs);
    this.#activationLeases.delete(sessionId);
    this.#runnable.add(sessionId);
    return {
      status: "restore_stale",
      consecutiveStales: count,
      retryAfterMs,
      releaseRequired: true,
    };
  }

  #nextNonce(): string {
    this.#nonce += 1;
    return stableOpaqueId("nonce", [this.#options.journalId, this.#nonce]);
  }
}

/** Creates a process-local authority; callers own its lifetime and persistence. */
export function createInMemoryDurableJournalAuthority(
  options: InMemoryDurableJournalOptions,
): InMemoryDurableJournalAuthority {
  return new InMemoryDurableJournalAuthority(options);
}

/**
 * Parses a serialized authority snapshot into canonical JSON and rejects malformed
 * nested collections before they can enter authority state.
 */
export function parseDurableAuthoritySnapshot(serialized: string): DurableAuthoritySnapshot {
  try {
    const value = assertJson(JSON.parse(serialized));
    if (!isDurableAuthoritySnapshot(value)) {
      throw invalidSnapshot();
    }
    return value;
  } catch (error) {
    if (error instanceof CrankError && error.code === "invalid_journal") {
      throw error;
    }
    throw invalidSnapshot(error);
  }
}

function isDurableAuthoritySnapshot(value: unknown): value is DurableAuthoritySnapshot {
  const keys = [
    "version",
    "tasks",
    "records",
    "runnable",
    "nonce",
    "activationLeases",
    "lastActivationEpochBySession",
    "taskRevisions",
    "restoreNonces",
    "restoreFrontierDigests",
    "consecutiveRestoreStales",
    "activationNotBeforeMs",
  ];
  if (!isJsonRecord(value) || !hasExactKeys(value, keys)) {
    return false;
  }
  return (
    value["version"] === 4 &&
    isNonNegativeInteger(value["nonce"]) &&
    Array.isArray(value["tasks"]) &&
    value["tasks"].every(isTaskSnapshot) &&
    Array.isArray(value["records"]) &&
    value["records"].every(isRecordCollection) &&
    Array.isArray(value["runnable"]) &&
    value["runnable"].every((entry) => typeof entry === "string") &&
    Array.isArray(value["activationLeases"]) &&
    value["activationLeases"].every(isActivationLeaseTuple) &&
    isStringNumberTupleArray(value["lastActivationEpochBySession"]) &&
    isStringNumberTupleArray(value["taskRevisions"]) &&
    isStringStringTupleArray(value["restoreNonces"]) &&
    isStringStringTupleArray(value["restoreFrontierDigests"]) &&
    isStringNumberTupleArray(value["consecutiveRestoreStales"]) &&
    isStringNumberTupleArray(value["activationNotBeforeMs"])
  );
}

function isStringNumberTupleArray(value: Json | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        isNonNegativeInteger(entry[1]),
    )
  );
}

function isStringStringTupleArray(value: Json | undefined): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    )
  );
}

function isActivationLeaseTuple(value: Json): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !isJsonRecord(value[1])
  ) {
    return false;
  }
  const lease = value[1];
  return (
    hasExactKeys(lease, [
      "sessionId",
      "ownerId",
      "epoch",
      "expiresAtMs",
      "leaseDurationMs",
      "claimedTaskRevision",
      "claimedHeadDigest",
      "restoreNonce",
    ]) &&
    lease["sessionId"] === value[0] &&
    typeof lease["ownerId"] === "string" &&
    isNonNegativeInteger(lease["epoch"]) &&
    isNonNegativeInteger(lease["expiresAtMs"]) &&
    isNonNegativeInteger(lease["leaseDurationMs"]) &&
    isNonNegativeInteger(lease["claimedTaskRevision"]) &&
    typeof lease["claimedHeadDigest"] === "string" &&
    typeof lease["restoreNonce"] === "string"
  );
}

function isTaskSnapshot(value: Json): boolean {
  if (!isJsonRecord(value)) {
    return false;
  }
  const required = [
    "sessionId",
    "turnId",
    "taskId",
    "manifest",
    "input",
    "executionEpoch",
    "attachmentId",
    "audience",
    "nextActionIndex",
    "nextPullIndex",
    "nextEmissionIndex",
    "pullsByAction",
    "emissionsByAction",
    "status",
    "cancellation",
  ];
  const optional = [
    "close",
    "parentTaskId",
    "parentPullId",
    "emissionPolicy",
    "acceptedEmissionCount",
    "cumulativeEmissionBytes",
    "catalog",
    "catalogDigest",
    "route",
  ];
  if (!hasOnlyKeys(value, required, optional)) {
    return false;
  }
  return (
    required.slice(0, 3).every((key) => typeof value[key] === "string") &&
    isManifestSnapshot(value["manifest"]) &&
    typeof value["attachmentId"] === "string" &&
    typeof value["audience"] === "string" &&
    ["executionEpoch", "nextActionIndex", "nextPullIndex", "nextEmissionIndex"].every((key) =>
      isNonNegativeInteger(value[key]),
    ) &&
    Array.isArray(value["pullsByAction"]) &&
    value["pullsByAction"].every(isIndexedPullTuple) &&
    Array.isArray(value["emissionsByAction"]) &&
    value["emissionsByAction"].every(isIndexedEmissionTuple) &&
    isTaskEmissionPolicySnapshot(value) &&
    ((value["catalog"] === undefined && value["catalogDigest"] === undefined) ||
      (isJsonRecord(value["catalog"]) && typeof value["catalogDigest"] === "string")) &&
    ["active", "closed", "cancelled", "orphaned"].includes(String(value["status"])) &&
    isCancellationStateSnapshot(value["cancellation"]) &&
    ["closed", "cancelled"].includes(String(value["status"])) ===
      isTaskCloseSnapshot(value["close"]) &&
    (value["parentTaskId"] === undefined) === (value["parentPullId"] === undefined) &&
    ["close", "parentTaskId", "parentPullId"].every(
      (key) =>
        value[key] === undefined || typeof value[key] === "string" || isJsonRecord(value[key]),
    )
  );
}

function isTaskEmissionPolicySnapshot(value: Record<string, Json>): boolean {
  const policy = value["emissionPolicy"];
  const count = value["acceptedEmissionCount"];
  const bytes = value["cumulativeEmissionBytes"];
  if (policy === undefined) {
    return count === undefined && bytes === undefined;
  }
  if (
    !isJsonRecord(policy) ||
    !isEmissionPolicyValue(policy) ||
    (policy["maxEmissionsPerTask"] === undefined &&
      policy["maxCumulativeEmissionBytes"] === undefined)
  ) {
    return false;
  }
  return (
    isNonNegativeInteger(count) &&
    isNonNegativeInteger(bytes) &&
    count === (value["emissionsByAction"] as Json[]).length
  );
}

function isManifestSnapshot(value: unknown): boolean {
  if (!isJsonRecord(value)) {
    return false;
  }
  const capabilities = value["capabilities"];
  const effects = value["effects"];
  if (
    !hasExactKeys(value, [
      "programId",
      "version",
      "digest",
      "inputSchema",
      "outputSchema",
      "elicits",
      "effects",
      "capabilities",
    ])
  ) {
    return false;
  }
  return (
    typeof value["programId"] === "string" &&
    typeof value["version"] === "string" &&
    typeof value["digest"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["digest"]) &&
    isSchemaDescriptorSnapshot(value["inputSchema"]) &&
    isSchemaDescriptorSnapshot(value["outputSchema"]) &&
    isJsonRecord(value["elicits"]) &&
    Object.values(value["elicits"]).every(
      (declaration) =>
        isJsonRecord(declaration) &&
        hasOnlyKeys(declaration, ["response"], ["context"]) &&
        isSchemaDescriptorSnapshot(declaration["response"]) &&
        (declaration["context"] === undefined ||
          isSchemaDescriptorSnapshot(declaration["context"])),
    ) &&
    isJsonRecord(effects) &&
    Object.entries(effects).every(
      ([name, effect]) =>
        isJsonRecord(effect) &&
        hasOnlyKeys(
          effect,
          ["name", "version", "inputSchema", "outputSchema", "retrySafety"],
          ["cancellation"],
        ) &&
        isSchemaDescriptorSnapshot(effect["inputSchema"]) &&
        isSchemaDescriptorSnapshot(effect["outputSchema"]) &&
        (effect["cancellation"] === undefined ||
          (isJsonRecord(effect["cancellation"]) &&
            hasExactKeys(effect["cancellation"], ["partialSchema"]) &&
            isSchemaDescriptorSnapshot(effect["cancellation"]["partialSchema"]))) &&
        effect["name"] === name &&
        typeof effect["version"] === "string" &&
        isRetrySafetySnapshot(effect["retrySafety"]),
    ) &&
    isJsonRecord(capabilities) &&
    hasExactKeys(capabilities, ["durableEmissions", "structuredChildren", "replay"]) &&
    typeof capabilities["durableEmissions"] === "boolean" &&
    typeof capabilities["structuredChildren"] === "boolean" &&
    capabilities["replay"] === "strict"
  );
}

function isRetrySafetySnapshot(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value["mode"] !== "string") {
    return false;
  }
  if (value["mode"] === "repeatable") {
    return hasExactKeys(value, ["mode"]);
  }
  if (value["mode"] === "unsafe") {
    return hasExactKeys(value, ["mode"]);
  }
  return (
    value["mode"] === "idempotent" &&
    hasExactKeys(value, ["mode", "mechanism"]) &&
    (value["mechanism"] === "pull_id_key" || value["mechanism"] === "inherent")
  );
}

function isTaskCloseSnapshot(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    hasExactKeys(value, ["digest", "receipt"]) &&
    typeof value["digest"] === "string" &&
    isJsonRecord(value["receipt"]) &&
    hasExactKeys(value["receipt"], ["offset", "duplicate"]) &&
    typeof value["receipt"]["offset"] === "string" &&
    typeof value["receipt"]["duplicate"] === "boolean"
  );
}

function isIndexedPullTuple(value: Json): boolean {
  if (!Array.isArray(value) || value.length !== 2 || !isNonNegativeInteger(value[0])) {
    return false;
  }
  const pull = value[1];
  if (
    !isJsonRecord(pull) ||
    !hasOnlyKeys(
      pull,
      [
        "pullId",
        "actionIndex",
        "pullIndex",
        "descriptor",
        "descriptorDigest",
        "effectiveDescriptor",
        "resultDescriptor",
        "resultSchemaDigest",
        "audience",
        "maxOutcomeBytes",
        "attempts",
        "revoked",
      ],
      ["capability", "outcome", "outcomeDigest", "receipt"],
    )
  ) {
    return false;
  }
  return (
    typeof pull["pullId"] === "string" &&
    isNonNegativeInteger(pull["actionIndex"]) &&
    isNonNegativeInteger(pull["pullIndex"]) &&
    isDescriptorSnapshot(pull["descriptor"]) &&
    typeof pull["descriptorDigest"] === "string" &&
    pull["descriptorDigest"] === canonicalSnapshot(pull["descriptor"]).sha &&
    isDescriptorSnapshot(pull["effectiveDescriptor"]) &&
    isSchemaDescriptorSnapshot(pull["resultDescriptor"]) &&
    typeof pull["resultSchemaDigest"] === "string" &&
    pull["resultSchemaDigest"] === (pull["resultDescriptor"] as Record<string, Json>)["digest"] &&
    typeof pull["audience"] === "string" &&
    isNonNegativeInteger(pull["maxOutcomeBytes"]) &&
    Array.isArray(pull["attempts"]) &&
    pull["attempts"].every(isAttemptSnapshot) &&
    typeof pull["revoked"] === "boolean" &&
    (pull["capability"] === undefined || typeof pull["capability"] === "string") &&
    (pull["outcome"] === undefined || isOperationOutcomeJson(pull["outcome"])) &&
    (pull["outcome"] === undefined) === (pull["outcomeDigest"] === undefined) &&
    (pull["outcome"] === undefined ||
      pull["outcomeDigest"] === canonicalSnapshot(pull["outcome"]).sha) &&
    (pull["outcome"] === undefined) === (pull["receipt"] === undefined) &&
    (pull["receipt"] === undefined || isResolutionReceiptJson(pull["receipt"]))
  );
}

function isResolutionReceiptJson(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    hasExactKeys(value, [
      "sessionId",
      "taskId",
      "pullId",
      "resolutionOffset",
      "outcomeDigest",
      "status",
    ]) &&
    ["sessionId", "taskId", "pullId", "resolutionOffset", "outcomeDigest"].every(
      (key) => typeof value[key] === "string",
    ) &&
    (value["status"] === "accepted" || value["status"] === "duplicate")
  );
}

function isDescriptorSnapshot(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value["kind"] !== "string") {
    return false;
  }
  switch (value["kind"]) {
    case "record":
      return (
        hasExactKeys(value, ["kind", "key", "retrySafety"]) &&
        typeof value["key"] === "string" &&
        value["key"].length > 0 &&
        new TextEncoder().encode(value["key"]).byteLength <= 128 &&
        isRetrySafetySnapshot(value["retrySafety"])
      );
    case "effect":
      return (
        hasExactKeys(value, ["kind", "name", "version", "input", "resolver"]) &&
        typeof value["name"] === "string" &&
        typeof value["version"] === "string" &&
        isJsonRecord(value["resolver"]) &&
        hasOnlyKeys(value["resolver"], ["audience"], ["route"]) &&
        typeof value["resolver"]["audience"] === "string" &&
        (value["resolver"]["route"] === undefined || typeof value["resolver"]["route"] === "string")
      );
    case "elicit":
      return (
        hasOnlyKeys(value, ["kind", "key", "message", "response"], ["context"]) &&
        typeof value["key"] === "string" &&
        typeof value["message"] === "string" &&
        isSchemaDescriptorSnapshot(value["response"])
      );
    case "wait": {
      const hasAbsolute =
        typeof value["notBefore"] === "string" && Number.isFinite(Date.parse(value["notBefore"]));
      const hasRelative = isNonNegativeInteger(value["durationMs"]);
      return (
        hasOnlyKeys(value, ["kind", "key"], ["notBefore", "durationMs"]) &&
        typeof value["key"] === "string" &&
        (hasAbsolute || hasRelative)
      );
    }
    case "invoke":
    case "spawn":
      return hasExactKeys(value, ["kind", "child"]) && isChildSnapshot(value["child"]);
    case "all":
    case "race":
      return (
        hasExactKeys(value, ["kind", "children"]) &&
        Array.isArray(value["children"]) &&
        value["children"].every(isChildSnapshot)
      );
    case "join":
      return (
        hasExactKeys(value, ["kind", "handle"]) &&
        isJsonRecord(value["handle"]) &&
        hasExactKeys(value["handle"], ["__durableTask", "owner"]) &&
        typeof value["handle"]["__durableTask"] === "string" &&
        typeof value["handle"]["owner"] === "string"
      );
    default:
      return false;
  }
}

function isSchemaDescriptorSnapshot(value: unknown): boolean {
  try {
    parsePortableSchemaDescriptor(value);
    return true;
  } catch {
    return false;
  }
}

function isChildSnapshot(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    hasExactKeys(value, ["id", "version", "digest", "input"]) &&
    typeof value["id"] === "string" &&
    typeof value["version"] === "string" &&
    typeof value["digest"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["digest"])
  );
}

function isAttemptSnapshot(value: Json): boolean {
  return (
    isJsonRecord(value) &&
    hasExactKeys(value, ["attemptId", "attemptIndex", "state", "capability"]) &&
    typeof value["attemptId"] === "string" &&
    isNonNegativeInteger(value["attemptIndex"]) &&
    ["started", "detached", "completed", "revoked", "superseded"].includes(
      String(value["state"]),
    ) &&
    typeof value["capability"] === "string"
  );
}

function isIndexedEmissionTuple(value: Json): boolean {
  if (!Array.isArray(value) || value.length !== 2 || !isNonNegativeInteger(value[0])) {
    return false;
  }
  const emission = value[1];
  return (
    isJsonRecord(emission) &&
    hasExactKeys(emission, ["digest", "receipt"]) &&
    typeof emission["digest"] === "string" &&
    isJsonRecord(emission["receipt"]) &&
    hasExactKeys(emission["receipt"], ["offset", "eventId", "duplicate"]) &&
    typeof emission["receipt"]["offset"] === "string" &&
    typeof emission["receipt"]["eventId"] === "string" &&
    typeof emission["receipt"]["duplicate"] === "boolean"
  );
}

function isRecordCollection(value: Json): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    Array.isArray(value[1]) &&
    value[1].every(
      (record) =>
        isJsonRecord(record) &&
        hasOnlyKeys(record, ["offset", "eventId", "sessionId", "payload"], ["ownerEpoch"]) &&
        (record["ownerEpoch"] === undefined || isNonNegativeInteger(record["ownerEpoch"])) &&
        typeof record["offset"] === "string" &&
        typeof record["eventId"] === "string" &&
        typeof record["sessionId"] === "string" &&
        isSemanticPayload(record["payload"]),
    )
  );
}

function isSemanticPayload(value: unknown): boolean {
  if (
    !isJsonRecord(value) ||
    typeof value["type"] !== "string" ||
    typeof value["taskId"] !== "string"
  ) {
    return false;
  }
  switch (value["type"]) {
    case "TaskOpened":
      return (
        hasOnlyKeys(
          value,
          [
            "type",
            "taskId",
            "turnId",
            "programId",
            "programVersion",
            "programDigest",
            "input",
            "inputDigest",
          ],
          ["parentTaskId", "parentPullId", "catalog", "catalogDigest"],
        ) &&
        ["turnId", "programId", "programVersion", "programDigest", "inputDigest"].every(
          (key) => typeof value[key] === "string",
        ) &&
        ((value["catalog"] === undefined && value["catalogDigest"] === undefined) ||
          (isJsonRecord(value["catalog"]) && typeof value["catalogDigest"] === "string"))
      );
    case "PullRequested":
      return (
        hasExactKeys(value, [
          "type",
          "taskId",
          "turnId",
          "actionIndex",
          "pullIndex",
          "pullId",
          "descriptor",
          "descriptorDigest",
        ]) &&
        typeof value["turnId"] === "string" &&
        isNonNegativeInteger(value["actionIndex"]) &&
        isNonNegativeInteger(value["pullIndex"]) &&
        typeof value["pullId"] === "string" &&
        isJsonRecord(value["descriptor"]) &&
        typeof value["descriptorDigest"] === "string"
      );
    case "AttemptStarted":
      return (
        hasExactKeys(value, ["type", "taskId", "pullId", "attemptId", "attemptIndex"]) &&
        typeof value["pullId"] === "string" &&
        typeof value["attemptId"] === "string" &&
        isNonNegativeInteger(value["attemptIndex"])
      );
    case "AttemptDetached":
    case "AttemptAbandoned":
      return (
        hasExactKeys(value, ["type", "taskId", "pullId", "attemptId", "reason"]) &&
        typeof value["pullId"] === "string" &&
        typeof value["attemptId"] === "string" &&
        typeof value["reason"] === "string"
      );
    case "AttemptSuperseded":
      return (
        hasExactKeys(value, ["type", "taskId", "pullId", "attemptId", "winnerAttemptId"]) &&
        typeof value["pullId"] === "string" &&
        typeof value["attemptId"] === "string" &&
        typeof value["winnerAttemptId"] === "string"
      );
    case "PullIndeterminate":
      return (
        hasExactKeys(value, ["type", "taskId", "pullId", "attemptId"]) &&
        typeof value["pullId"] === "string" &&
        typeof value["attemptId"] === "string"
      );
    case "PullResolved":
      return (
        hasOnlyKeys(
          value,
          ["type", "taskId", "pullId", "outcome", "outcomeDigest"],
          ["attemptId"],
        ) &&
        typeof value["pullId"] === "string" &&
        (value["attemptId"] === undefined || typeof value["attemptId"] === "string") &&
        isOperationOutcomeJson(value["outcome"]) &&
        typeof value["outcomeDigest"] === "string"
      );
    case "DurableEmission":
      return (
        hasExactKeys(value, [
          "type",
          "taskId",
          "actionIndex",
          "emissionIndex",
          "descriptor",
          "descriptorDigest",
        ]) &&
        isNonNegativeInteger(value["actionIndex"]) &&
        isNonNegativeInteger(value["emissionIndex"]) &&
        isJsonRecord(value["descriptor"]) &&
        hasExactKeys(value["descriptor"], ["eventType", "payload"]) &&
        typeof value["descriptor"]["eventType"] === "string" &&
        typeof value["descriptorDigest"] === "string"
      );
    case "RaceWinnerSelected":
      return (
        hasExactKeys(value, [
          "type",
          "taskId",
          "pullId",
          "winnerTaskId",
          "closeOffset",
          "outcomeDigest",
        ]) &&
        typeof value["pullId"] === "string" &&
        typeof value["winnerTaskId"] === "string" &&
        typeof value["closeOffset"] === "string" &&
        typeof value["outcomeDigest"] === "string"
      );
    case "CancellationRequested":
      return (
        hasOnlyKeys(value, ["type", "taskId", "commandId", "frontier"], ["reason"]) &&
        typeof value["commandId"] === "string" &&
        (value["reason"] === undefined || typeof value["reason"] === "string") &&
        isCancellationFrontierSnapshot(value["frontier"])
      );
    case "CancellationPartialDiscarded":
      return (
        hasExactKeys(value, ["type", "taskId", "pullId", "reason"]) &&
        typeof value["pullId"] === "string" &&
        (value["reason"] === "schema_validation_failed" ||
          value["reason"] === "payload_too_large" ||
          value["reason"] === "schema_version_unavailable")
      );
    case "AttemptOutcomeUnknown":
      return (
        hasOnlyKeys(value, ["type", "taskId", "pullId", "reason"], ["attemptId"]) &&
        typeof value["pullId"] === "string" &&
        (value["attemptId"] === undefined || typeof value["attemptId"] === "string") &&
        (value["reason"] === "no_settlement_path" || value["reason"] === "force_orphaned")
      );
    case "CleanupSkipped":
    case "TaskOrphaned":
      return (
        hasExactKeys(value, ["type", "taskId", "reason"]) &&
        (value["reason"] === "program_version_unavailable" ||
          value["reason"] === "program_corrupt" ||
          value["reason"] === "cleanup_stuck" ||
          value["reason"] === "replay_execution_failed" ||
          value["reason"] === "replay_diverged")
      );
    case "TaskClosed":
      return (
        hasExactKeys(value, ["type", "taskId", "outcome"]) &&
        isOperationOutcomeJson(value["outcome"])
      );
    default:
      return false;
  }
}

function isOperationOutcomeJson(value: unknown): boolean {
  if (!isJsonRecord(value)) {
    return false;
  }
  switch (value["status"]) {
    case "ok":
      return hasExactKeys(value, ["status", "value"]);
    case "error":
      return (
        hasExactKeys(value, ["status", "error"]) &&
        isJsonRecord(value["error"]) &&
        hasOnlyKeys(value["error"], ["code", "message"], ["details"]) &&
        typeof value["error"]["code"] === "string" &&
        typeof value["error"]["message"] === "string"
      );
    case "cancelled":
      return hasOnlyKeys(value, ["status"], ["partial"]);
    default:
      return false;
  }
}

function isCancellationFrontierSnapshot(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    hasOnlyKeys(value, ["actionIndex"], ["pullId"]) &&
    isNonNegativeInteger(value["actionIndex"]) &&
    (value["pullId"] === undefined || typeof value["pullId"] === "string")
  );
}

function isCancellationStateSnapshot(value: unknown): boolean {
  if (!isJsonRecord(value) || typeof value["type"] !== "string") {
    return false;
  }
  switch (value["type"]) {
    case "none":
      return hasExactKeys(value, ["type"]);
    case "requested":
      return (
        hasOnlyKeys(value, ["type", "commandId", "frontier"], ["reason"]) &&
        typeof value["commandId"] === "string" &&
        (value["reason"] === undefined || typeof value["reason"] === "string") &&
        isCancellationFrontierSnapshot(value["frontier"])
      );
    case "settling_effect":
      return (
        hasOnlyKeys(value, ["type", "commandId", "pullId", "frontier"], ["reason"]) &&
        typeof value["commandId"] === "string" &&
        typeof value["pullId"] === "string" &&
        (value["reason"] === undefined || typeof value["reason"] === "string") &&
        isCancellationFrontierSnapshot(value["frontier"])
      );
    case "cancelling_children":
      return (
        hasOnlyKeys(value, ["type", "commandId", "childTaskIds", "frontier"], ["reason"]) &&
        typeof value["commandId"] === "string" &&
        Array.isArray(value["childTaskIds"]) &&
        value["childTaskIds"].every((entry) => typeof entry === "string") &&
        (value["reason"] === undefined || typeof value["reason"] === "string") &&
        isCancellationFrontierSnapshot(value["frontier"])
      );
    case "unwinding":
      return (
        hasOnlyKeys(value, ["type", "commandId", "frontier"], ["reason"]) &&
        typeof value["commandId"] === "string" &&
        (value["reason"] === undefined || typeof value["reason"] === "string") &&
        isCancellationFrontierSnapshot(value["frontier"])
      );
    case "cancelled":
      return hasExactKeys(value, ["type", "commandId"]) && typeof value["commandId"] === "string";
    case "orphaned":
      return (
        hasExactKeys(value, ["type", "reason"]) &&
        (value["reason"] === "program_version_unavailable" ||
          value["reason"] === "program_corrupt" ||
          value["reason"] === "cleanup_stuck" ||
          value["reason"] === "replay_execution_failed" ||
          value["reason"] === "replay_diverged")
      );
    default:
      return false;
  }
}

function isJsonRecord(value: unknown): value is Record<string, Json> {
  return (
    value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

function isNonNegativeInteger(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function hasOnlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function sanitizeCancellationReason(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  const normalized = [...reason]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return normalized.slice(0, 512);
}

function parseRestoreTicketClaims(value: unknown): RestoreTicketClaims {
  if (
    !isJsonRecord(value) ||
    !hasOnlyKeys(
      value,
      [
        "version",
        "journalId",
        "journalIncarnation",
        "sessionId",
        "taskId",
        "ownerId",
        "activationEpoch",
        "taskRevision",
        "journalHeadDigest",
        "replayedThroughActionIndex",
        "replayChainDigest",
        "restoreNonce",
      ],
      ["releaseId", "sandboxSessionId", "replayDomain", "frontierDomain"],
    )
  ) {
    throw new CrankError("restore_stale");
  }
  const stringFields = [
    "journalId",
    "journalIncarnation",
    "sessionId",
    "taskId",
    "ownerId",
    "journalHeadDigest",
    "replayChainDigest",
    "restoreNonce",
  ];
  const optionalStrings = ["releaseId", "sandboxSessionId", "replayDomain", "frontierDomain"];
  if (
    value["version"] !== 1 ||
    !stringFields.every((field) => typeof value[field] === "string") ||
    !optionalStrings.every(
      (field) => value[field] === undefined || typeof value[field] === "string",
    ) ||
    !isNonNegativeInteger(value["activationEpoch"]) ||
    !isNonNegativeInteger(value["taskRevision"]) ||
    !(
      typeof value["replayedThroughActionIndex"] === "number" &&
      Number.isSafeInteger(value["replayedThroughActionIndex"]) &&
      value["replayedThroughActionIndex"] >= -1
    )
  ) {
    throw new CrankError("restore_stale");
  }
  // SAFETY: every field RestoreTicketClaims declares is checked immediately
  // above and the guard throws restore_stale on any mismatch, so this point is
  // unreachable for a shape the claims type does not describe.
  return value as unknown as RestoreTicketClaims;
}

function invalidSnapshot(cause?: unknown): CrankError {
  return new CrankError("invalid_journal", "Invalid durable authority snapshot", undefined, {
    cause,
  });
}

function effectContractKey(name: string, version: string): string {
  return `${name}\u0000${version}`;
}

function effectDigestForPull(task: Task, pull: Pull): string {
  const descriptor = pull.effectiveDescriptor;
  if (descriptor.kind !== "effect") {
    throw new CrankError("invalid_manifest", "Authorized pull is not an installed effect");
  }
  const definition = task.manifest.effects[descriptor.name];
  if (!definition || definition.version !== descriptor.version) {
    throw new CrankError("invalid_manifest", "Authorized effect contract is unavailable");
  }
  return effectContractDigest(definition);
}

function canonicalByteLength(value: Json): number {
  return new TextEncoder().encode(canonicalSnapshot(value).canonical).byteLength;
}

function normalizeEmissionPolicy(
  policy: SemanticEmissionPolicy | undefined,
): SemanticEmissionPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (!isEmissionPolicyValue(policy)) {
    throw new CrankError("invalid_manifest", "Invalid semantic emission policy");
  }
  if (policy.maxEmissionsPerTask === undefined && policy.maxCumulativeEmissionBytes === undefined) {
    return undefined;
  }
  return structuredClone(policy);
}

function isEmissionPolicyValue(value: unknown): value is SemanticEmissionPolicy {
  if (!isJsonRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, [], ["maxEmissionsPerTask", "maxCumulativeEmissionBytes"])) {
    return false;
  }
  return [value["maxEmissionsPerTask"], value["maxCumulativeEmissionBytes"]].every(
    (limit) => limit === undefined || isNonNegativeInteger(limit),
  );
}

function operationPolicy(
  manifest: DurableProgramManifest,
  descriptor: DurableOperationDescriptor,
): {
  resultDescriptor: PortableSchemaDescriptor;
  audience: string;
  inputDigest?: string;
  contextDigest?: string;
} {
  switch (descriptor.kind) {
    case "record":
      if (
        typeof descriptor.key !== "string" ||
        descriptor.key.length === 0 ||
        new TextEncoder().encode(descriptor.key).byteLength > 128
      ) {
        throw new CrankError("invalid_descriptor", "Invalid record key");
      }
      return { resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR, audience: "program-execution" };
    case "effect": {
      const definition = manifest.effects[descriptor.name];
      if (!definition || definition.version !== descriptor.version) {
        throw new CrankError(
          "invalid_descriptor",
          `Undeclared effect ${descriptor.name}@${descriptor.version}`,
        );
      }
      return {
        resultDescriptor: definition.outputSchema,
        audience: descriptor.resolver.audience,
        inputDigest: definition.inputSchema.digest,
      };
    }
    case "elicit": {
      const declaration = manifest.elicits[descriptor.key];
      if (!declaration) {
        throw new CrankError("invalid_descriptor", `Undeclared elicitation ${descriptor.key}`);
      }
      if (declaration.response.digest !== descriptor.response.digest) {
        throw new CrankError(
          "invalid_descriptor",
          "Elicitation content schema differs from manifest",
        );
      }
      if ((declaration.context === undefined) !== (descriptor.context === undefined)) {
        throw new CrankError(
          "invalid_descriptor",
          "Elicitation authored context presence differs from manifest",
        );
      }
      return {
        resultDescriptor: declaration.response,
        audience: `user:${descriptor.key}`,
        ...(declaration.context !== undefined ? { contextDigest: declaration.context.digest } : {}),
      };
    }
    case "wait":
      if ((descriptor.notBefore === undefined) === (descriptor.durationMs === undefined)) {
        throw new CrankError("invalid_descriptor", "Wait requires exactly one deadline form");
      }
      if (
        descriptor.notBefore !== undefined &&
        !Number.isFinite(Date.parse(descriptor.notBefore))
      ) {
        throw new CrankError("invalid_descriptor", "Invalid wait deadline");
      }
      if (
        descriptor.durationMs !== undefined &&
        (!Number.isSafeInteger(descriptor.durationMs) || descriptor.durationMs < 0)
      ) {
        throw new CrankError("invalid_descriptor", "Invalid wait duration");
      }
      return { resultDescriptor: NULL_RESULT_SCHEMA_DESCRIPTOR, audience: "scheduler" };
    case "invoke":
    case "all":
    case "race":
    case "spawn":
    case "join":
      if (!manifest.capabilities.structuredChildren) {
        throw new CrankError("invalid_descriptor", "Program does not declare structured children");
      }
      return { resultDescriptor: ANY_JSON_SCHEMA_DESCRIPTOR, audience: "child-runtime" };
  }
}

function installedOrRecordedDescriptor(
  descriptor: DurableOperationDescriptor,
): Extract<DurableOperationDescriptor, { kind: "effect" | "record" }> {
  if (descriptor.kind !== "effect" && descriptor.kind !== "record") {
    throw new CrankError("invalid_descriptor", "Authorized pull is not executable");
  }
  return descriptor;
}

function parseWireElicitEnvelope(
  value: Json,
):
  | { action: "accept"; content: Json }
  | { action: "decline" | "cancel"; reason?: string }
  | undefined {
  if (!isJsonRecord(value) || typeof value["action"] !== "string") {
    return undefined;
  }
  if (value["action"] === "accept") {
    if (!("content" in value) || !hasOnlyKeys(value, ["action", "content"], [])) {
      return undefined;
    }
    return { action: "accept", content: value["content"] as Json };
  }
  if (value["action"] === "decline" || value["action"] === "cancel") {
    if (!hasOnlyKeys(value, ["action"], ["reason"])) {
      return undefined;
    }
    const reason = value["reason"];
    if (reason !== undefined && typeof reason !== "string") {
      return undefined;
    }
    return {
      action: value["action"],
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  return undefined;
}

function snapshotDescriptor(descriptor: DurableOperationDescriptor): DurableOperationDescriptor {
  const snapshot = canonicalSnapshot(descriptor).value;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !["effect", "record", "elicit", "wait", "invoke", "all", "race", "spawn", "join"].includes(
      snapshot.kind,
    )
  ) {
    throw new CrankError("invalid_descriptor");
  }
  return snapshot;
}

function snapshotOutcome(outcome: OperationOutcome): OperationOutcome {
  const snapshot = canonicalSnapshot(outcome).value;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !["ok", "error", "cancelled"].includes(snapshot.status)
  ) {
    throw new CrankError("schema_validation_failed");
  }
  return snapshot;
}

function pendingReason(descriptor: DurableOperationDescriptor): "elicit" | "wait" | "child" {
  if (descriptor.kind === "elicit") {
    return "elicit";
  }
  if (descriptor.kind === "wait") {
    return "wait";
  }
  return "child";
}

function taskKey(sessionId: string, taskId: string): string {
  return `${sessionId}\u0000${taskId}`;
}

function manifestSchemaDigests(manifest: DurableProgramManifest): string[] {
  return [
    manifest.inputSchema.digest,
    manifest.outputSchema.digest,
    ...Object.values(manifest.elicits).flatMap((elicit) => [
      elicit.response.digest,
      ...(elicit.context ? [elicit.context.digest] : []),
    ]),
    ...Object.values(manifest.effects).flatMap((effect) => [
      effect.inputSchema.digest,
      effect.outputSchema.digest,
      ...(effect.cancellation ? [effect.cancellation.partialSchema.digest] : []),
    ]),
  ];
}

function sortedStrings(values: Iterable<string>): string[] {
  const result: string[] = [];
  for (const value of values) {
    let index = 0;
    while (index < result.length) {
      const current = result[index];
      if (current === undefined || current >= value) {
        break;
      }
      index += 1;
    }
    result.splice(index, 0, value);
  }
  return result;
}
