import type { Operation } from "effection";

import { assertInlineSize, assertSchemaValue, DEFAULT_MAX_INLINE_BYTES } from "./authoring.ts";
import {
  signCapability,
  verifyProgramCapability,
  verifyResolutionCapability,
  type CapabilityKeyring,
} from "./capabilities.ts";
import { assertJson, canonicalSnapshot, stableOpaqueId } from "./canonical.ts";
import { CrankError, type Json } from "./types.ts";
import { hasLiveDurableEffect, signalLiveDurableEffect } from "./durable-cancellation-live.ts";
import type {
  AppendEmissionRequest,
  CancellationAcknowledgement,
  CompleteTaskRequest,
  DurableCancellationState,
  DurableJournalAuthorityService,
  DurableOperationDescriptor,
  DurableProgramManifest,
  EmissionReceipt,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  OperationOutcome,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolutionCapabilityClaims,
  ResolutionReceipt,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "./durable-types.ts";

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
        reason: "schema_validation_failed" | "payload_too_large";
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
        reason: "program_version_unavailable" | "program_corrupt" | "cleanup_stuck";
      }
    | {
        type: "TaskOrphaned";
        taskId: string;
        reason: "program_version_unavailable" | "program_corrupt" | "cleanup_stuck";
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
  resultSchema: Json;
  resultSchemaDigest: string;
  audience: string;
  maxOutcomeBytes: number;
  attempts: Attempt[];
  capability?: string;
  outcome?: OperationOutcome;
  outcomeDigest?: string;
  receipt?: ResolutionReceipt;
  indeterminate: boolean;
  revoked: boolean;
};

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
  status: "active" | "closed" | "cancelled" | "orphaned";
  cancellation: DurableCancellationState;
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
  version: 2;
  tasks: TaskSnapshot[];
  records: Array<[string, DurableSemanticRecord[]]>;
  runnable: string[];
  nonce: number;
}

/** Composition options for a process-local authority and optional parsed snapshot. */
export interface InMemoryDurableJournalOptions {
  journalId: string;
  journalIncarnation?: string;
  keyring: CapabilityKeyring;
  now?: () => number;
  maxOutcomeBytes?: number;
  snapshot?: DurableAuthoritySnapshot;
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
  readonly #options: Required<Omit<InMemoryDurableJournalOptions, "keyring" | "snapshot">> & {
    keyring: CapabilityKeyring;
  };
  #nonce = 0;

  /** Creates an empty authority or restores a previously parsed snapshot. */
  constructor(options: InMemoryDurableJournalOptions) {
    if (!options.journalId) {
      throw new CrankError("invalid_manifest", "journalId is required");
    }
    this.#options = {
      ...options,
      journalIncarnation: options.journalIncarnation ?? "1",
      now: options.now ?? Date.now,
      maxOutcomeBytes: options.maxOutcomeBytes ?? DEFAULT_MAX_INLINE_BYTES,
    };
    if (options.snapshot) {
      this.#restore(options.snapshot);
    }
  }

  /** Opens one pinned task exactly once and returns attachment-bound authority. */
  *openTask(request: OpenDurableTaskRequest): Operation<{ programCapability: string }> {
    const key = taskKey(request.sessionId, request.taskId);
    if (this.#tasks.has(key)) {
      throw new CrankError("invalid_journal", "Task already exists");
    }
    const input = assertSchemaValue(
      request.manifest.inputSchema,
      request.input,
      "invalid_descriptor",
    );
    assertInlineSize(input, this.#options.maxOutcomeBytes);
    const task: Task = {
      ...request,
      input,
      nextActionIndex: 0,
      nextPullIndex: 0,
      nextEmissionIndex: 0,
      pullsByAction: new Map(),
      emissionsByAction: new Map(),
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
      ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
      ...(request.parentPullId ? { parentPullId: request.parentPullId } : {}),
    });
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
      if (existing.indeterminate) {
        return { status: "pending", pullId: existing.pullId, reason: "indeterminate" };
      }
      if (descriptor.kind === "effect") {
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
    if (
      task.cancellation.type !== "none" &&
      task.cancellation.type !== "unwinding" &&
      task.cancellation.type !== "cancelled" &&
      task.cancellation.type !== "orphaned" &&
      request.actionIndex >= task.cancellation.frontier.actionIndex
    ) {
      throw new CrankError("cancellation_blocked", "Cancellation must unwind before new work");
    }
    if (request.actionIndex !== task.nextActionIndex || request.pullIndex !== task.nextPullIndex) {
      throw new CrankError("nondeterminism_detected", "Task-local action or pull cursor mismatch");
    }
    const policy = operationPolicy(task.manifest, descriptor);
    const pullId = stableOpaqueId("pull", [
      request.sessionId,
      request.turnId,
      request.taskId,
      request.pullIndex,
    ]);
    let effectiveDescriptor = descriptor;
    if (descriptor.kind === "wait" && descriptor.durationMs !== undefined) {
      effectiveDescriptor = {
        ...descriptor,
        notBefore: new Date(this.#options.now() + descriptor.durationMs).toISOString(),
      };
    }
    const pull: Pull = {
      pullId,
      actionIndex: request.actionIndex,
      pullIndex: request.pullIndex,
      descriptor,
      descriptorDigest,
      effectiveDescriptor,
      resultSchema: policy.resultSchema,
      resultSchemaDigest: canonicalSnapshot(policy.resultSchema).sha,
      audience: policy.audience,
      maxOutcomeBytes: this.#options.maxOutcomeBytes,
      attempts: [],
      indeterminate: false,
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
    if (descriptor.kind === "effect") {
      return this.#startAttempt(task, pull);
    }
    pull.capability = this.#resolutionCapability(task, pull, undefined);
    return {
      status: "pending",
      pullId,
      reason: pendingReason(descriptor),
      resolutionCapability: pull.capability,
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
    if (
      pull.descriptorDigest !== claims.descriptorDigest ||
      pull.resultSchemaDigest !== claims.resultSchemaDigest
    ) {
      return { status: "rejected", code: "invalid_resolution_capability" };
    }
    const attempt =
      claims.attemptId === "none"
        ? undefined
        : pull.attempts.find((candidate) => candidate.attemptId === claims.attemptId);
    if (
      pull.revoked ||
      (claims.attemptId !== "none" && (!attempt || attempt.state === "revoked"))
    ) {
      return { status: "rejected", code: "capability_revoked" };
    }
    if (task.status !== "active") {
      return { status: "rejected", code: "task_terminal" };
    }
    let outcome: OperationOutcome;
    try {
      outcome = snapshotOutcome(request.outcome);
      if (outcome.status === "cancelled" && outcome.partial !== undefined) {
        const definition =
          pull.descriptor.kind === "effect"
            ? task.manifest.effects[pull.descriptor.name]
            : undefined;
        try {
          if (!definition?.cancellation) {
            throw new CrankError("schema_validation_failed");
          }
          const partial = assertSchemaValue(definition.cancellation.partialSchema, outcome.partial);
          assertInlineSize(partial, Math.min(claims.maxOutcomeBytes, pull.maxOutcomeBytes));
          outcome = { status: "cancelled", partial };
        } catch (error) {
          const reason =
            error instanceof CrankError && error.code === "payload_too_large"
              ? "payload_too_large"
              : "schema_validation_failed";
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
        assertInlineSize(outcome, Math.min(claims.maxOutcomeBytes, pull.maxOutcomeBytes));
      }
      if (outcome.status === "ok") {
        assertSchemaValue(pull.resultSchema, outcome.value);
      }
    } catch (error) {
      if (error instanceof CrankError && error.code === "payload_too_large") {
        return { status: "rejected", code: "payload_too_large" };
      }
      return { status: "rejected", code: "schema_validation_failed" };
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
    pull.indeterminate = false;
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
    const offset = this.#append(task.sessionId, task.executionEpoch, {
      type: "DurableEmission",
      taskId: task.taskId,
      actionIndex: request.actionIndex,
      emissionIndex: task.nextEmissionIndex++,
      descriptor,
      descriptorDigest: digest,
    });
    const receipt = { offset, eventId: `journal:${task.sessionId}:${offset}`, duplicate: false };
    task.emissionsByAction.set(request.actionIndex, { digest, receipt });
    task.nextActionIndex += 1;
    return receipt;
  }

  /** Closes a task exactly once after validating its manifest output schema. */
  *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
    const task = this.#task(request.sessionId, request.taskId);
    this.#assertProgram(request.programCapability, task);
    const proposedOutcome = snapshotOutcome(request.outcome);
    const outcome: OperationOutcome =
      task.cancellation.type === "unwinding" ? { status: "cancelled" } : proposedOutcome;
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
    if (outcome.status === "ok") {
      assertSchemaValue(task.manifest.outputSchema, outcome.value);
    }
    const offset = this.#append(task.sessionId, task.executionEpoch, {
      type: "TaskClosed",
      taskId: task.taskId,
      outcome,
    });
    const receipt = { offset, duplicate: false };
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
          frontierPull.descriptor.kind === "effect" &&
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

  /** Marks a live attempt detached without revoking its resolution capability. */
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

  /** Retries an unsafe indeterminate effect only with explicit duplicate-risk acknowledgement. */
  *retryIndeterminateEffect(
    sessionId: string,
    taskId: string,
    pullId: string,
    acknowledgeDuplicateRisk: boolean,
  ): Operation<ReserveOperationResult> {
    if (!acknowledgeDuplicateRisk) {
      throw new CrankError("retry_ack_required");
    }
    const task = this.#task(sessionId, taskId);
    const pull = this.#pull(task, pullId);
    if (!pull.indeterminate || pull.descriptor.kind !== "effect") {
      throw new CrankError("invalid_command");
    }
    pull.indeterminate = false;
    return this.#startAttempt(task, pull);
  }

  /** Orphans a task whose pinned program cannot be recovered safely. */
  *forceOrphan(
    sessionId: string,
    taskId: string,
    reason: "program_version_unavailable" | "program_corrupt" | "cleanup_stuck",
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
      status: task.status,
      cancellation: task.cancellation,
      ...(task.close ? { close: task.close } : {}),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ...(task.parentPullId ? { parentPullId: task.parentPullId } : {}),
    }));
    return {
      version: 2,
      tasks: structuredClone(tasks),
      records: structuredClone([...this.#records.entries()]),
      runnable: [...this.#runnable],
      nonce: this.#nonce,
    };
  }

  /** Returns runnable session IDs in deterministic lexical order. */
  runnableSessions(): string[] {
    return sortedStrings(this.#runnable);
  }

  /** Clears a session's runnable marker after an activation owner claims it. */
  *markActivated(sessionId: string): Operation<void> {
    this.#runnable.delete(sessionId);
  }

  /** Returns a defensive cancellation-state snapshot for fresh replay. */
  *cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState> {
    return structuredClone(this.#task(sessionId, taskId).cancellation);
  }

  /** Begins one-shot authored unwind after the fixed frontier has settled. */
  *beginCancellationUnwind(sessionId: string, taskId: string): Operation<DurableCancellationState> {
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
    task.cancellation = {
      type: "unwinding",
      commandId: current.commandId,
      ...(current.reason !== undefined ? { reason: current.reason } : {}),
      frontier: current.frontier,
    };
    return structuredClone(task.cancellation);
  }

  #restore(snapshot: DurableAuthoritySnapshot): void {
    if (
      snapshot.version !== 2 ||
      !Array.isArray(snapshot.tasks) ||
      !Array.isArray(snapshot.records)
    ) {
      throw new CrankError("invalid_journal", "Invalid durable authority snapshot");
    }
    this.#tasks.clear();
    this.#records.clear();
    this.#runnable.clear();
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
    for (const sessionId of snapshot.runnable) {
      this.#runnable.add(sessionId);
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
      return {
        status: "authorized",
        pullId: pull.pullId,
        attemptId: active.attemptId,
        resolutionCapability: active.capability,
      };
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
    return {
      status: "authorized",
      pullId: pull.pullId,
      attemptId,
      resolutionCapability: capability,
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
    pull.indeterminate = false;
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
      if (pull.descriptor.kind === "effect") {
        const definition = task.manifest.effects[pull.descriptor.name];
        if (definition?.retrySafety.mode === "unsafe") {
          pull.indeterminate = true;
          this.#append(task.sessionId, undefined, {
            type: "PullIndeterminate",
            taskId: task.taskId,
            pullId: pull.pullId,
            attemptId: attempt.attemptId,
          });
        }
      }
    }
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
    return offset;
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
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, ["version", "tasks", "records", "runnable", "nonce"])
  ) {
    return false;
  }
  return (
    value["version"] === 2 &&
    isNonNegativeInteger(value["nonce"]) &&
    Array.isArray(value["tasks"]) &&
    value["tasks"].every(isTaskSnapshot) &&
    Array.isArray(value["records"]) &&
    value["records"].every(isRecordCollection) &&
    Array.isArray(value["runnable"]) &&
    value["runnable"].every((entry) => typeof entry === "string")
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
  const optional = ["close", "parentTaskId", "parentPullId"];
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
    ["active", "closed", "cancelled", "orphaned"].includes(String(value["status"])) &&
    isCancellationStateSnapshot(value["cancellation"]) &&
    ["closed", "cancelled"].includes(String(value["status"])) ===
      isTaskCloseSnapshot(value["close"]) &&
    (value["parentTaskId"] === undefined) === (value["parentPullId"] === undefined) &&
    optional.every(
      (key) =>
        value[key] === undefined || typeof value[key] === "string" || isJsonRecord(value[key]),
    )
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
    isJsonRecord(value["elicits"]) &&
    Object.values(value["elicits"]).every(
      (declaration) =>
        isJsonRecord(declaration) &&
        hasOnlyKeys(declaration, ["responseSchema"], ["contextSchema"]),
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
        (effect["cancellation"] === undefined ||
          (isJsonRecord(effect["cancellation"]) &&
            hasExactKeys(effect["cancellation"], ["partialSchema"]))) &&
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
  if (value["mode"] === "unsafe") {
    return (
      hasExactKeys(value, ["mode", "onIndeterminate"]) &&
      (value["onIndeterminate"] === "await_decision" || value["onIndeterminate"] === "fail")
    );
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
        "resultSchema",
        "resultSchemaDigest",
        "audience",
        "maxOutcomeBytes",
        "attempts",
        "indeterminate",
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
    typeof pull["resultSchemaDigest"] === "string" &&
    pull["resultSchemaDigest"] === canonicalSnapshot(pull["resultSchema"]).sha &&
    typeof pull["audience"] === "string" &&
    isNonNegativeInteger(pull["maxOutcomeBytes"]) &&
    Array.isArray(pull["attempts"]) &&
    pull["attempts"].every(isAttemptSnapshot) &&
    typeof pull["indeterminate"] === "boolean" &&
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
        hasOnlyKeys(value, ["kind", "key", "message", "responseSchema"], ["context"]) &&
        typeof value["key"] === "string" &&
        typeof value["message"] === "string"
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
          ["parentTaskId", "parentPullId"],
        ) &&
        ["turnId", "programId", "programVersion", "programDigest", "inputDigest"].every(
          (key) => typeof value[key] === "string",
        )
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
        (value["reason"] === "schema_validation_failed" || value["reason"] === "payload_too_large")
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
          value["reason"] === "cleanup_stuck")
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
          value["reason"] === "cleanup_stuck")
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

function invalidSnapshot(cause?: unknown): CrankError {
  return new CrankError("invalid_journal", "Invalid durable authority snapshot", undefined, {
    cause,
  });
}

function operationPolicy(
  manifest: DurableProgramManifest,
  descriptor: DurableOperationDescriptor,
): { resultSchema: Json; audience: string } {
  switch (descriptor.kind) {
    case "effect": {
      const definition = manifest.effects[descriptor.name];
      if (!definition || definition.version !== descriptor.version) {
        throw new CrankError(
          "invalid_descriptor",
          `Undeclared effect ${descriptor.name}@${descriptor.version}`,
        );
      }
      assertSchemaValue(definition.inputSchema, descriptor.input, "invalid_descriptor");
      return { resultSchema: definition.outputSchema, audience: descriptor.resolver.audience };
    }
    case "elicit": {
      const declaration = manifest.elicits[descriptor.key];
      if (!declaration) {
        throw new CrankError("invalid_descriptor", `Undeclared elicitation ${descriptor.key}`);
      }
      if (
        canonicalSnapshot(declaration.responseSchema).sha !==
        canonicalSnapshot(descriptor.responseSchema).sha
      ) {
        throw new CrankError(
          "invalid_descriptor",
          "Elicitation response schema differs from manifest",
        );
      }
      if (descriptor.context !== undefined && declaration.contextSchema !== undefined) {
        assertSchemaValue(declaration.contextSchema, descriptor.context, "invalid_descriptor");
      }
      return { resultSchema: declaration.responseSchema, audience: `user:${descriptor.key}` };
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
      return { resultSchema: { type: "null" }, audience: "scheduler" };
    case "invoke":
    case "all":
    case "race":
    case "spawn":
    case "join":
      if (!manifest.capabilities.structuredChildren) {
        throw new CrankError("invalid_descriptor", "Program does not declare structured children");
      }
      return { resultSchema: true, audience: "child-runtime" };
  }
}

function snapshotDescriptor(descriptor: DurableOperationDescriptor): DurableOperationDescriptor {
  const snapshot = canonicalSnapshot(descriptor).value;
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    !["effect", "elicit", "wait", "invoke", "all", "race", "spawn", "join"].includes(snapshot.kind)
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
