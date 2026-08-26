import {
  CrankError,
  assertInlineSize,
  type DurableProgramManifest,
  type Mandate,
} from "@sweatpants/durable-execution";
import { canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import type { AuthorityState } from "./authority-contract.ts";
import type { DecisionDraft } from "./decision-draft.ts";
import { pullById, terminalOutcome, type DraftTask } from "./decision-state.ts";
import { currentForkGroupRevision, parkedHead, planForestReplay, strandHead } from "./forest-replay.ts";
import { resolveForkDeadline } from "./fork-group.ts";
import { effectContractDigest } from "./authority-support.ts";
import type {
  BindMandateRequest,
  BindMandateResult,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  OpenDurableTaskRequest,
  ReleaseMandateRequest,
  ReleaseMandateResult,
} from "./authority-types.ts";

export interface TaskDecisionServices {
  detachAttempts(draft: DecisionDraft, sessionId: string, task: DraftTask, reason: string): void;
}

export function openTask(
  draft: DecisionDraft,
  request: OpenDurableTaskRequest,
): { programCapability: string } {
  const session = draft.session(request.sessionId);
  if (session.execution.tasks.has(request.taskId))
    throw new CrankError("invalid_journal", "Task already exists");
  const input = draft.parseSchema(
    request.manifest.inputSchema.digest,
    request.input,
    "invalid_descriptor",
  );
  assertInlineSize(input, draft.maxOutcomeBytes);
  assertEffectContractsCompatible(draft.state, request.manifest);
  if ((request.catalog === undefined) !== (request.catalogDigest === undefined)) {
    throw new CrankError(
      "invalid_manifest",
      "Catalog and catalog digest must be supplied together",
    );
  }
  const catalog =
    request.catalog === undefined ? undefined : canonicalSnapshot(request.catalog).value;
  if (
    catalog !== undefined &&
    (typeof catalog !== "object" ||
      Array.isArray(catalog) ||
      (catalog as Record<string, Json>)["digest"] !== request.catalogDigest)
  )
    throw new CrankError("invalid_manifest", "Accepted catalog digest differs");
  if (catalog !== undefined) assertInlineSize(catalog, draft.maxOutcomeBytes);
  const origin = request.parentTaskId
    ? {
        kind: "child" as const,
        invokedBy: { taskId: request.parentTaskId, pullId: request.parentPullId! },
      }
    : { kind: "root" as const };
  // Expiry caps flow downward (REQ-030): explicit policies resolve against the
  // ancestor cap; descendants without one inherit it; roots without one carry
  // no policy, so a later `inherit` fork admission fails closed.
  let deadlineMs: number | undefined;
  if (request.expiryPolicy !== undefined) {
    const ancestor =
      request.parentTaskId === undefined
        ? undefined
        : draft.task(request.sessionId, request.parentTaskId).deadlineMs;
    deadlineMs = resolveForkDeadline(request.expiryPolicy, ancestor, draft.context.nowMs);
  } else if (request.parentTaskId !== undefined) {
    deadlineMs = draft.task(request.sessionId, request.parentTaskId).deadlineMs;
  }
  const task: DraftTask = {
    taskId: request.taskId,
    turnId: request.turnId,
    origin,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    program: {
      artifact: {
        id: request.manifest.programId,
        version: request.manifest.version,
        digest: request.manifest.digest,
      },
      manifest: structuredClone(request.manifest),
      input,
    },
    execution: {
      epoch: request.executionEpoch,
      attachmentId: request.attachmentId,
      audience: request.audience,
      ...(request.elicitAudience === undefined ? {} : { elicitAudience: request.elicitAudience }),
      ...(request.route === undefined ? {} : { route: structuredClone(request.route) }),
      ...(catalog === undefined ? {} : { catalog, catalogDigest: request.catalogDigest! }),
    },
    actions: [],
    nextActionIndex: 0,
    nextPullIndex: 0,
    nextEmissionIndex: 0,
    ...(draft.emissionPolicy === undefined
      ? {}
      : {
          emissionPolicy: structuredClone(draft.emissionPolicy),
        }),
    acceptedEmissionCount: 0,
    cumulativeEmissionBytes: 0,
    lifecycle: { status: "active", cancellation: { type: "none" } },
  };
  session.execution.tasks.set(request.taskId, task);
  draft.append(request.sessionId, request.executionEpoch, {
    type: "TaskOpened",
    taskId: request.taskId,
    turnId: request.turnId,
    programId: request.manifest.programId,
    programVersion: request.manifest.version,
    programDigest: request.manifest.digest,
    input,
    inputDigest: canonicalSnapshot(input).sha,
    ...(catalog === undefined ? {} : { catalog, catalogDigest: request.catalogDigest! }),
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    ...(request.parentPullId === undefined ? {} : { parentPullId: request.parentPullId }),
    ...(request.elicitAudience === undefined ? {} : { elicitAudience: request.elicitAudience }),
  });
  session.control.runnable = true;
  return { programCapability: draft.programCapability(task) };
}

export function bindAttachment(
  draft: DecisionDraft,
  request: { sessionId: string; taskId: string; attachmentId: string; executionEpoch: number },
  services: TaskDecisionServices,
): { programCapability: string } {
  const session = draft.session(request.sessionId);
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertActive(task);
  session.control.runnable = false;
  if (task.execution.epoch !== request.executionEpoch)
    throw new CrankError("stale_program_capability");
  if (task.execution.attachmentId !== request.attachmentId) {
    services.detachAttempts(draft, request.sessionId, task, "attachment_replaced");
    task.execution.attachmentId = request.attachmentId;
  }
  return { programCapability: draft.programCapability(task) };
}

export function bindMandate(
  draft: DecisionDraft,
  request: BindMandateRequest,
): BindMandateResult {
  if (
    !request.ownerId ||
    !Number.isSafeInteger(request.leaseDurationMs) ||
    request.leaseDurationMs < 1 ||
    request.leaseDurationMs > 300_000
  ) {
    throw new CrankError("invalid_command", "Invalid task lease request");
  }
  const session = draft.session(request.address.sessionId);
  const task = draft.task(request.address.sessionId, request.address.taskId);
  draft.assertActive(task);
  if (
    request.strand !== task.taskId ||
    request.address.turnId !== task.turnId ||
    request.program.id !== task.program.artifact.id ||
    request.program.version !== task.program.artifact.version ||
    request.program.digest !== task.program.artifact.digest
  ) {
    throw new CrankError("nondeterminism_detected", "Prepared target identity differs");
  }
  const head = strandHead(task);
  if (
    head.digest !== request.expected.strandHeadDigest ||
    request.frontierProof.strandHeadDigest !== request.expected.strandHeadDigest ||
    request.frontierProof.replayedThroughActionIndex !== head.actionIndex
  ) {
    return { status: "stale", mismatch: "strand_head" };
  }
  if (
    task.execution.epoch !== request.expected.leaseEpoch ||
    (task.execution.liveLease !== undefined &&
      draft.context.nowMs < task.execution.liveLease.expiresAtMs)
  ) {
    return { status: "stale", mismatch: "lease_epoch" };
  }
  const groupRevision = currentForkGroupRevision(session, task.taskId);
  if (groupRevision !== request.expected.forkGroupRevision) {
    return { status: "stale", mismatch: "fork_group_revision" };
  }
  const planned = planForestReplay(
    draft.state,
    request.address.sessionId,
    draft.context.journalHeadDigest,
    draft.context.nowMs,
  );
  const row = planned.rows.find((candidate) => candidate.address.taskId === task.taskId);
  if (row?.classification !== "replayable" || parkedHead(task) !== undefined) {
    return { status: "stale", mismatch: "strand_head" };
  }

  // The conditional state transition is the complete guard: no separate
  // validate/claim phase exists. Advancing the epoch fences every older bind.
  task.execution.epoch += 1;
  task.execution.attachmentId = request.attachmentId;
  const expiresAtMs = draft.context.nowMs + request.leaseDurationMs;
  task.execution.liveLease = {
    ownerId: request.ownerId,
    epoch: task.execution.epoch,
    expiresAtMs,
    attachmentId: request.attachmentId,
    strandHeadDigest: head.digest,
    forkGroupRevision: groupRevision,
    frontierDigest: request.frontierProof.frontierDigest,
  };
  draft.append(request.address.sessionId, task.execution.epoch, {
    type: "AdvancementBound",
    taskId: task.taskId,
    ownerId: request.ownerId,
    leaseEpoch: task.execution.epoch,
    expiresAtMs,
    attachmentId: request.attachmentId,
    strandHeadDigest: head.digest,
    forkGroupRevision: groupRevision,
    frontierDigest: request.frontierProof.frontierDigest,
  });
  session.control.runnable = false;
  const programCapability = draft.programCapability(
    task,
    stableTupleHash([
      "mandate",
      request.address.sessionId,
      task.taskId,
      task.execution.epoch,
      request.attachmentId,
      head.digest,
      groupRevision,
    ]),
  );
  const mandate: Mandate = {
    kind: "mandate",
    address: structuredClone(request.address),
    strand: request.strand,
    program: structuredClone(task.program.artifact),
    placement: structuredClone(request.placement),
    attachment: {
      attachmentId: request.attachmentId,
      boundAtRevision: session.control.revision,
    },
    groupContext: structuredClone(row.groupContext),
    lease: { ownerId: request.ownerId, epoch: task.execution.epoch, expiresAtMs },
    boundFrontier: structuredClone(request.frontierProof),
    programCapability,
  };
  return { status: "bound", mandate };
}

export function releaseMandate(
  draft: DecisionDraft,
  request: ReleaseMandateRequest,
): ReleaseMandateResult {
  const mandate = request.mandate;
  const task = draft.task(mandate.address.sessionId, mandate.address.taskId);
  const lease = task.execution.liveLease;
  if (
    lease === undefined ||
    lease.ownerId !== mandate.lease.ownerId ||
    lease.epoch !== mandate.lease.epoch ||
    lease.attachmentId !== mandate.attachment.attachmentId
  ) {
    return { status: "stale" };
  }
  draft.assertProgram(mandate.programCapability, task, mandate.address.sessionId);
  delete task.execution.liveLease;
  draft.append(mandate.address.sessionId, mandate.lease.epoch, {
    type: "AdvancementReleased",
    taskId: task.taskId,
    leaseEpoch: mandate.lease.epoch,
    reason: request.reason,
  });
  const session = draft.session(mandate.address.sessionId);
  session.control.runnable =
    request.reason === "settled" || request.reason === "failed" || request.reason === "scope_exit";
  return { status: "released" };
}

export function replaceAttachment(
  draft: DecisionDraft,
  request: { sessionId: string; taskId: string; attachmentId: string; audience?: string },
  services: TaskDecisionServices,
): { executionEpoch: number; programCapability: string } {
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  if (lease && draft.context.nowMs < lease.expiresAtMs) {
    throw new CrankError(
      "stale_activation",
      "replaceAttachment is not valid for an unexpired lease-managed session",
    );
  }
  if (lease) {
    delete session.control.activationLease;
    session.control.runnable = true;
  }
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertActive(task);
  services.detachAttempts(draft, request.sessionId, task, "attachment_replaced");
  task.execution.epoch += 1;
  task.execution.attachmentId = request.attachmentId;
  if (request.audience !== undefined) task.execution.audience = request.audience;
  return { executionEpoch: task.execution.epoch, programCapability: draft.programCapability(task) };
}

export function ensureChild(draft: DecisionDraft, request: EnsureChildTaskRequest): EnsureChildTaskResult {
  const parent = draft.task(request.sessionId, request.parentTaskId);
  draft.assertActive(parent);
  const parentPull = pullById(parent, request.parentPullId);
  if (parentPull.request.acceptedDescriptor.kind !== "invoke") {
    throw new CrankError("invalid_descriptor", "Parent pull is not a child invocation");
  }
  const expected = parentPull.request.acceptedDescriptor.child;
  if (
    expected.id !== request.child.id ||
    expected.version !== request.child.version ||
    expected.digest !== request.child.digest ||
    canonicalSnapshot(expected.input).sha !== canonicalSnapshot(request.child.input).sha
  )
    throw new CrankError("nondeterminism_detected", "Child descriptor differs from parent pull");
  const existing = [...draft.session(request.sessionId).execution.tasks.values()].find(
    (task) =>
      task.origin.kind === "child" &&
      task.origin.invokedBy.taskId === request.parentTaskId &&
      task.origin.invokedBy.pullId === request.parentPullId,
  );
  if (existing) {
    if (
      existing.program.artifact.id !== request.manifest.programId ||
      existing.program.artifact.version !== request.manifest.version ||
      existing.program.artifact.digest !== request.manifest.digest
    ) {
      throw new CrankError("program_version_mismatch");
    }
    const outcome = terminalOutcome(existing);
    return outcome === undefined
      ? { taskId: existing.taskId }
      : { taskId: existing.taskId, outcome };
  }
  const ordinal = [...draft.session(request.sessionId).execution.tasks.values()].filter(
    (task) => task.origin.kind === "child" && task.origin.invokedBy.taskId === request.parentTaskId,
  ).length;
  const taskId = `${request.parentTaskId}.${ordinal}`;
  openTask(draft, {
    sessionId: request.sessionId,
    turnId: request.turnId,
    taskId,
    manifest: request.manifest,
    input: request.child.input,
    executionEpoch: request.executionEpoch,
    attachmentId: "unattached-child",
    audience: request.audience,
    ...(parent.execution.elicitAudience === undefined
      ? {}
      : { elicitAudience: parent.execution.elicitAudience }),
    ...(parent.execution.catalog === undefined
      ? {}
      : { catalog: parent.execution.catalog, catalogDigest: parent.execution.catalogDigest! }),
    ...(request.route === undefined ? {} : { route: request.route }),
    parentTaskId: request.parentTaskId,
    parentPullId: request.parentPullId,
  });
  return { taskId };
}

function assertEffectContractsCompatible(
  state: AuthorityState,
  manifest: DurableProgramManifest,
): void {
  const retained = new Map<string, string>();
  for (const session of state.sessions.values()) {
    for (const task of session.execution.tasks.values()) {
      for (const definition of Object.values(task.program.manifest.effects)) {
        retained.set(
          stableTupleHash([definition.name, definition.version]),
          effectContractDigest(definition),
        );
      }
    }
  }
  for (const definition of Object.values(manifest.effects)) {
    const key = stableTupleHash([definition.name, definition.version]);
    const digest = effectContractDigest(definition);
    if (retained.has(key) && retained.get(key) !== digest) {
      throw new CrankError("invalid_manifest");
    }
  }
}

