import type { Operation } from "effection";

import { assertInlineSize, assertSchemaValue, DEFAULT_MAX_INLINE_BYTES } from "./authoring.ts";
import {
  signCapability,
  verifyProgramCapability,
  verifyResolutionCapability,
  type CapabilityKeyring,
} from "./capabilities.ts";
import { canonicalSnapshot, stableOpaqueId } from "./canonical.ts";
import { CrankError, type Json } from "./types.ts";
import type {
  AppendEmissionRequest,
  CompleteTaskRequest,
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

export type DurableAttemptState = "started" | "detached" | "completed" | "revoked" | "superseded";

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
    | { type: "CancellationRequested"; taskId: string; reason?: string }
    | {
        type: "CleanupSkipped";
        taskId: string;
        reason: "program_version_unavailable" | "program_corrupt";
      }
    | {
        type: "TaskOrphaned";
        taskId: string;
        reason: "program_version_unavailable" | "program_corrupt";
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
  close?: { digest: string; receipt: TaskCloseReceipt };
  parentTaskId?: string;
  parentPullId?: string;
};

type TaskSnapshot = Omit<Task, "pullsByAction" | "emissionsByAction"> & {
  pullsByAction: Array<[number, Pull]>;
  emissionsByAction: Array<[number, { digest: string; receipt: EmissionReceipt }]>;
};

export interface DurableAuthoritySnapshot {
  version: 1;
  tasks: TaskSnapshot[];
  records: Array<[string, DurableSemanticRecord[]]>;
  runnable: string[];
  nonce: number;
}

export interface InMemoryDurableJournalOptions {
  journalId: string;
  journalIncarnation?: string;
  keyring: CapabilityKeyring;
  now?: () => number;
  maxOutcomeBytes?: number;
  snapshot?: DurableAuthoritySnapshot;
}

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

export class InMemoryDurableJournalAuthority implements DurableJournalAuthorityService {
  readonly #tasks = new Map<string, Task>();
  readonly #records = new Map<string, DurableSemanticRecord[]>();
  readonly #runnable = new Set<string>();
  readonly #options: Required<Omit<InMemoryDurableJournalOptions, "keyring" | "snapshot">> & {
    keyring: CapabilityKeyring;
  };
  #nonce = 0;

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
    if (claims.attemptId !== "none" && (!attempt || attempt.state === "revoked")) {
      return { status: "rejected", code: "capability_revoked" };
    }
    if (task.status !== "active") {
      return { status: "rejected", code: "task_terminal" };
    }
    let outcome: OperationOutcome;
    try {
      outcome = snapshotOutcome(request.outcome);
      assertInlineSize(outcome, Math.min(claims.maxOutcomeBytes, pull.maxOutcomeBytes));
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
    this.#runnable.add(task.sessionId);
    return { status: "accepted", receipt };
  }

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

  *complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt> {
    const task = this.#task(request.sessionId, request.taskId);
    this.#assertProgram(request.programCapability, task);
    const outcome = snapshotOutcome(request.outcome);
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
    return receipt;
  }

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

  *forceOrphan(
    sessionId: string,
    taskId: string,
    reason: "program_version_unavailable" | "program_corrupt",
  ): Operation<void> {
    const task = this.#task(sessionId, taskId);
    if (task.status === "orphaned") {
      return;
    }
    this.#assertActive(task);
    for (const pull of task.pullsByAction.values()) {
      for (const attempt of pull.attempts) {
        if (attempt.state === "started" || attempt.state === "detached") {
          attempt.state = "revoked";
        }
      }
    }
    this.#append(sessionId, undefined, { type: "CleanupSkipped", taskId, reason });
    this.#append(sessionId, undefined, { type: "TaskOrphaned", taskId, reason });
    task.status = "orphaned";
  }

  resolutionCapability(sessionId: string, taskId: string, pullId: string): string {
    const task = this.#task(sessionId, taskId);
    const pull = this.#pull(task, pullId);
    if (!pull.capability) {
      pull.capability = this.#resolutionCapability(task, pull, undefined);
    }
    return pull.capability;
  }

  readJournal(sessionId: string): DurableSemanticRecord[] {
    return structuredClone(this.#records.get(sessionId) ?? []);
  }

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
      ...(task.close ? { close: task.close } : {}),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      ...(task.parentPullId ? { parentPullId: task.parentPullId } : {}),
    }));
    return {
      version: 1,
      tasks: structuredClone(tasks),
      records: structuredClone([...this.#records.entries()]),
      runnable: [...this.#runnable],
      nonce: this.#nonce,
    };
  }

  runnableSessions(): string[] {
    return sortedStrings(this.#runnable);
  }

  markActivated(sessionId: string): void {
    this.#runnable.delete(sessionId);
  }

  #restore(snapshot: DurableAuthoritySnapshot): void {
    if (
      snapshot.version !== 1 ||
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

export function createInMemoryDurableJournalAuthority(
  options: InMemoryDurableJournalOptions,
): InMemoryDurableJournalAuthority {
  return new InMemoryDurableJournalAuthority(options);
}

export function parseDurableAuthoritySnapshot(serialized: string): DurableAuthoritySnapshot {
  const value: unknown = JSON.parse(serialized);
  if (!isDurableAuthoritySnapshot(value)) {
    throw new CrankError("invalid_journal", "Invalid durable authority snapshot");
  }
  return value;
}

function isDurableAuthoritySnapshot(value: unknown): value is DurableAuthoritySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (!("version" in value) || value.version !== 1) {
    return false;
  }
  if (!("tasks" in value) || !Array.isArray(value.tasks)) {
    return false;
  }
  if (!("records" in value) || !Array.isArray(value.records)) {
    return false;
  }
  if (!("runnable" in value) || !Array.isArray(value.runnable)) {
    return false;
  }
  return "nonce" in value && typeof value.nonce === "number";
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
