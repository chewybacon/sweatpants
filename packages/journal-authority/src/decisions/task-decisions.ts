import {
  CrankError,
  assertInlineSize,
  encodeInlineJson,
  type DurableProgramManifest,
  type Mandate,
} from "@sweatpants/durable-execution";
import {
  stableTupleHash,
  type Json,
  sha256,
  encodeCanonicalJson,
  canonicalJson,
  cloneJson,
} from "@sweatpants/foundation";
import type { AuthorityState, TaskState } from "../contract/authority-contract.ts";
import { parseDurableProgramManifest } from "../store/durable-authority-snapshot-schema.ts";
import type { DecisionDraft } from "./decision-draft.ts";
import type { AuthorityKernel } from "../state/authority-transaction.ts";
import { pullById, terminalOutcome, type DraftTask } from "./decision-state.ts";
import {
  currentForkGroupRevision,
  parkedHead,
  planForestReplay,
  strandHead,
} from "../forest/forest-replay.ts";
import { resolveForkDeadline } from "../forest/fork-group.ts";
import { effectContractDigest } from "../state/authority-support.ts";
import type {
  BindMandateRequest,
  BindMandateResult,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  OpenDurableTaskRequest,
  ReleaseMandateRequest,
  ReleaseMandateResult,
} from "../contract/authority-types.ts";

export function openTask(
  draft: DecisionDraft,
  supplied: OpenDurableTaskRequest,
): { programCapability: string } {
  // Manifest schemas may normalize their representation. Admit them at task
  // creation so the owned state and its persisted projection already agree.
  const request = { ...supplied, manifest: parseDurableProgramManifest(supplied.manifest) };
  const session = draft.session(request.sessionId);
  if (session.execution.tasks.has(request.taskId)) {
    throw new CrankError("invalid_journal", "Task already exists");
  }
  const input = draft.parseSchema(
    request.manifest.inputSchema.digest,
    request.input,
    "invalid_descriptor",
  );
  const encodedInput = encodeInlineJson(input, draft.maxOutcomeBytes);
  assertEffectContractsCompatible(draft.state, request.manifest);
  if ((request.catalog === undefined) !== (request.catalogDigest === undefined)) {
    throw new CrankError(
      "invalid_manifest",
      "Catalog and catalog digest must be supplied together",
    );
  }
  const catalog = request.catalog === undefined ? undefined : cloneJson(request.catalog);
  if (
    catalog !== undefined &&
    (typeof catalog !== "object" ||
      Array.isArray(catalog) ||
      (catalog as Record<string, Json>)["digest"] !== request.catalogDigest)
  ) {
    throw new CrankError("invalid_manifest", "Accepted catalog digest differs");
  }
  if (catalog !== undefined) {
    assertInlineSize(catalog, draft.maxOutcomeBytes);
  }
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
        : draft.readTask(request.sessionId, request.parentTaskId).deadlineMs;
    deadlineMs = resolveForkDeadline(request.expiryPolicy, ancestor, draft.context.nowMs);
  } else if (request.parentTaskId !== undefined) {
    deadlineMs = draft.readTask(request.sessionId, request.parentTaskId).deadlineMs;
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
      manifest: request.manifest,
      input,
    },
    execution: taskExecution(request, catalog),
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
  if (origin.kind === "root") {
    const retainedRoots = [...session.execution.tasks.values()].filter(
      (candidate) => candidate.origin.kind === "root",
    ).length;
    session.control.nextRootOrdinal =
      (session.control.nextRootOrdinal ?? Math.max(0, retainedRoots - 1)) + 1;
  }
  draft.append(request.sessionId, request.executionEpoch, {
    type: "TaskOpened",
    taskId: request.taskId,
    turnId: request.turnId,
    programId: request.manifest.programId,
    programVersion: request.manifest.version,
    programDigest: request.manifest.digest,
    input,
    inputDigest: sha256(encodedInput),
    ...(catalog === undefined ? {} : { catalog, catalogDigest: request.catalogDigest! }),
    ...(request.parentTaskId === undefined ? {} : { parentTaskId: request.parentTaskId }),
    ...(request.parentPullId === undefined ? {} : { parentPullId: request.parentPullId }),
    ...(request.elicitAudience === undefined ? {} : { elicitAudience: request.elicitAudience }),
  });
  session.control.runnable = true;
  return { programCapability: draft.programCapability(task) };
}

export function bindAttachment(
  kernel: AuthorityKernel,
  request: { sessionId: string; taskId: string; attachmentId: string; executionEpoch: number },
): { programCapability: string } {
  const { draft } = kernel;
  const session = draft.session(request.sessionId);
  const task = draft.task(request.sessionId, request.taskId);
  draft.assertActive(task);
  session.control.runnable = false;
  if (task.execution.epoch !== request.executionEpoch) {
    throw new CrankError("stale_program_capability");
  }
  if (task.execution.attachmentId !== request.attachmentId) {
    kernel.detachAttempts(request.sessionId, task, "attachment_replaced");
    task.execution.attachmentId = request.attachmentId;
  }
  return { programCapability: draft.programCapability(task) };
}

export function bindMandate(draft: DecisionDraft, request: BindMandateRequest): BindMandateResult {
  if (
    !request.ownerId ||
    !Number.isSafeInteger(request.leaseDurationMs) ||
    request.leaseDurationMs < 1 ||
    request.leaseDurationMs > 300_000
  ) {
    throw new CrankError("invalid_command", "Invalid task lease request");
  }
  const acceptedSession = draft.readSession(request.address.sessionId);
  const acceptedTask = draft.readTask(request.address.sessionId, request.address.taskId);
  draft.assertActive(acceptedTask);
  if (
    request.strand !== acceptedTask.taskId ||
    request.address.turnId !== acceptedTask.turnId ||
    request.program.id !== acceptedTask.program.artifact.id ||
    request.program.version !== acceptedTask.program.artifact.version ||
    request.program.digest !== acceptedTask.program.artifact.digest
  ) {
    throw new CrankError("nondeterminism_detected", "Prepared target identity differs");
  }
  const head = strandHead(acceptedTask);
  if (
    head.digest !== request.expected.strandHeadDigest ||
    request.frontierProof.strandHeadDigest !== request.expected.strandHeadDigest ||
    request.frontierProof.replayedThroughActionIndex !== head.actionIndex
  ) {
    return { status: "stale", mismatch: "strand_head" };
  }
  if (
    acceptedTask.execution.epoch !== request.expected.leaseEpoch ||
    (acceptedTask.execution.liveLease !== undefined &&
      draft.context.nowMs < acceptedTask.execution.liveLease.expiresAtMs)
  ) {
    return { status: "stale", mismatch: "lease_epoch" };
  }
  const groupRevision = currentForkGroupRevision(acceptedSession, acceptedTask.taskId);
  if (groupRevision !== request.expected.forkGroupRevision) {
    return { status: "stale", mismatch: "fork_group_revision" };
  }
  const planned = planForestReplay(
    draft.state,
    request.address.sessionId,
    draft.context.journalHeadId,
    draft.context.nowMs,
  );
  const row = planned.rows.find((candidate) => candidate.address.taskId === acceptedTask.taskId);
  if (row?.classification !== "replayable" || parkedHead(acceptedTask) !== undefined) {
    return { status: "stale", mismatch: "strand_head" };
  }

  const task = draft.task(request.address.sessionId, request.address.taskId);
  const session = draft.session(request.address.sessionId);
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
  const current = draft.readTask(mandate.address.sessionId, mandate.address.taskId);
  const lease = current.execution.liveLease;
  if (
    lease === undefined ||
    lease.ownerId !== mandate.lease.ownerId ||
    lease.epoch !== mandate.lease.epoch ||
    lease.attachmentId !== mandate.attachment.attachmentId
  ) {
    return { status: "stale" };
  }
  draft.assertProgram(mandate.programCapability, current, mandate.address.sessionId);
  const task = draft.task(mandate.address.sessionId, mandate.address.taskId);
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
  kernel: AuthorityKernel,
  request: { sessionId: string; taskId: string; attachmentId: string; audience?: string },
): { executionEpoch: number; programCapability: string } {
  const { draft } = kernel;
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
  kernel.detachAttempts(request.sessionId, task, "attachment_replaced");
  task.execution.epoch += 1;
  task.execution.attachmentId = request.attachmentId;
  if (request.audience !== undefined) {
    task.execution.audience = request.audience;
  }
  return { executionEpoch: task.execution.epoch, programCapability: draft.programCapability(task) };
}

export function ensureChild(
  draft: DecisionDraft,
  request: EnsureChildTaskRequest,
): EnsureChildTaskResult {
  const parent = draft.readTask(request.sessionId, request.parentTaskId);
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
    encodeCanonicalJson(expected.input) !== canonicalJson(request.child.input)
  ) {
    throw new CrankError("nondeterminism_detected", "Child descriptor differs from parent pull");
  }
  const existing = [...draft.readSession(request.sessionId).execution.tasks.values()].find(
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
  const ordinal = [...draft.readSession(request.sessionId).execution.tasks.values()].filter(
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
    ...inheritedChildExecutionOptions(parent, request.route),
    parentTaskId: request.parentTaskId,
    parentPullId: request.parentPullId,
  });
  return { taskId };
}

function taskExecution(
  request: OpenDurableTaskRequest,
  catalog: Json | undefined,
): DraftTask["execution"] {
  return {
    epoch: request.executionEpoch,
    attachmentId: request.attachmentId,
    audience: request.audience,
    ...(request.elicitAudience === undefined ? {} : { elicitAudience: request.elicitAudience }),
    ...(request.route === undefined ? {} : { route: structuredClone(request.route) }),
    ...(catalog === undefined ? {} : { catalog, catalogDigest: request.catalogDigest! }),
  };
}

function inheritedChildExecutionOptions(
  parent: TaskState,
  route: OpenDurableTaskRequest["route"],
): Pick<OpenDurableTaskRequest, "elicitAudience" | "catalog" | "catalogDigest" | "route"> {
  return {
    ...(parent.execution.elicitAudience === undefined
      ? {}
      : { elicitAudience: parent.execution.elicitAudience }),
    ...(parent.execution.catalog === undefined
      ? {}
      : { catalog: parent.execution.catalog, catalogDigest: parent.execution.catalogDigest! }),
    ...(route === undefined ? {} : { route }),
  };
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
