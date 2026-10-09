import {
  CrankError,
  assertInlineSize,
  encodeInlineJson,
  type DurableOperationDescriptor,
  type Mandate,
  type ResolutionReceipt,
} from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import {
  stableTupleHash,
  type Json,
  canonicalDigest,
  canonicalSnapshot,
  encodeCanonicalJson,
  sha256,
} from "@sweatpants/foundation";
import type {
  AuthorityState,
  ResolutionAuthority,
  TaskState,
  PullState,
} from "../contract/authority-contract.ts";
import type { DecisionDraft } from "./decision-draft.ts";
import type { AuthorityKernel } from "../state/authority-transaction.ts";
import {
  currentAttempt,
  emissionByAction,
  findTaskPullById,
  pullActionIndex,
  pullAudience,
  pullById,
  taskOriginSession,
  type DraftPull,
  type DraftTask,
} from "./decision-state.ts";
import { consumeRestoredFrontier } from "./recovery-decisions.ts";
import { endLiveLease } from "../store/live-lease.ts";
import { pullKindPolicy } from "../pull-kinds/index.ts";
import { verifyResolutionCapability } from "../contract/capabilities.ts";
import { parseRegisteredSchema } from "../contract/schema-registry.ts";
import {
  effectDigestForPull,
  identityConflict,
  installedOrRecordedDescriptor,
  isModelSampleDescriptor,
  MAX_OPEN_ELICITATIONS,
  modelPullOwnerFence,
  operationPolicy,
  parseProgramElicitResult,
  pendingReason,
  sanitizeCancellationReason,
  snapshotOutcome,
} from "../state/authority-support.ts";
import type {
  AcceptAssistantPartialRequest,
  AcceptAssistantPartialResult,
  AcceptPullPreparationRequest,
  AcceptPullPreparationResult,
  AppendEmissionRequest,
  CompleteTaskRequest,
  CompleteTaskResult,
  EmissionReceipt,
  LiveReservationResult,
  MandateCompleteRequest,
  MandateEmissionRequest,
  MandateReserveRequest,
  ReserveOperationRequest,
  ReserveOperationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  TaskCloseReceipt,
} from "../contract/authority-types.ts";

function resolutionConflictCode(
  attempt: DraftPull["attempts"][number] | undefined,
): "resolution_conflict" | "idempotency_conflict" {
  if (attempt === undefined) {
    return "resolution_conflict";
  }
  switch (attempt.status) {
    case "superseded":
      return "idempotency_conflict";
    case "started":
    case "detached":
    case "completed":
    case "revoked":
      return "resolution_conflict";
  }
}

function mandateTask(draft: DecisionDraft, mandate: Mandate): TaskState {
  const task = draft.readTask(mandate.address.sessionId, mandate.address.taskId);
  const lease = task.execution.liveLease;
  if (
    mandate.strand !== task.taskId ||
    mandate.address.turnId !== task.turnId ||
    mandate.program.id !== task.program.artifact.id ||
    mandate.program.version !== task.program.artifact.version ||
    mandate.program.digest !== task.program.artifact.digest ||
    lease === undefined ||
    lease.ownerId !== mandate.lease.ownerId ||
    lease.epoch !== mandate.lease.epoch ||
    lease.attachmentId !== mandate.attachment.attachmentId ||
    lease.strandHeadDigest !== mandate.boundFrontier.strandHeadDigest ||
    lease.frontierDigest !== mandate.boundFrontier.frontierDigest ||
    lease.forkGroupRevision !== mandate.groupContext.groupRevision ||
    draft.context.nowMs >= lease.expiresAtMs
  ) {
    throw new CrankError("stale_program_capability", "Mandate is stale");
  }
  draft.assertActive(task);
  draft.assertProgram(mandate.programCapability, task, mandate.address.sessionId);
  return task;
}

export function reserveUnderMandate(
  draft: DecisionDraft,
  request: MandateReserveRequest,
): LiveReservationResult {
  const task = mandateTask(draft, request.mandate);
  const result = reservePull(draft, {
    sessionId: request.mandate.address.sessionId,
    turnId: request.mandate.address.turnId,
    taskId: task.taskId,
    actionIndex: task.nextActionIndex,
    pullIndex: task.nextPullIndex,
    descriptor: request.descriptor,
    programCapability: request.mandate.programCapability,
  });
  if (result.status === "resolved") {
    throw new CrankError("replay_diverged", "Recorded history crossed the live edge");
  }
  if (result.status === "pending") {
    endLiveLease(
      draft,
      request.mandate.address.sessionId,
      draft.task(request.mandate.address.sessionId, task.taskId),
      "parked",
    );
  }
  return result;
}

export function emitUnderMandate(
  draft: DecisionDraft,
  request: MandateEmissionRequest,
): EmissionReceipt {
  const task = mandateTask(draft, request.mandate);
  return appendEmission(draft, {
    sessionId: request.mandate.address.sessionId,
    taskId: task.taskId,
    actionIndex: task.nextActionIndex,
    descriptor: request.descriptor,
    programCapability: request.mandate.programCapability,
  });
}

export function completeUnderMandate(
  kernel: AuthorityKernel,
  request: MandateCompleteRequest,
): CompleteTaskResult {
  const { draft } = kernel;
  const task = mandateTask(draft, request.mandate);
  const result = completeTask(kernel, {
    sessionId: request.mandate.address.sessionId,
    taskId: task.taskId,
    actionIndex: task.nextActionIndex,
    outcome: request.outcome,
    programCapability: request.mandate.programCapability,
  });
  if (result.status !== "rejected") {
    endLiveLease(
      draft,
      request.mandate.address.sessionId,
      draft.task(request.mandate.address.sessionId, task.taskId),
      "terminal",
    );
  }
  return result;
}

export function reservePull(
  draft: DecisionDraft,
  request: ReserveOperationRequest,
): ReserveOperationResult {
  const observed = draft.readTask(request.sessionId, request.taskId);
  draft.assertProgram(request.programCapability, observed, request.sessionId);
  draft.assertActive(observed);
  if (request.turnId !== observed.turnId) {
    throw new CrankError("invalid_descriptor", "Turn identity mismatch");
  }
  const encoded = canonicalSnapshot(request.descriptor);
  const descriptor = encoded.value;
  const descriptorDigest = sha256(encoded.canonical);
  const existingAction = observed.actions.find(
    (action) => action.kind === "pull" && action.actionIndex === request.actionIndex,
  );
  const existing = existingAction?.kind === "pull" ? existingAction.pull : undefined;
  if (existing) {
    if (
      existing.request.proposedDescriptorDigest !== descriptorDigest ||
      existingAction?.kind !== "pull" ||
      existingAction.pullIndex !== request.pullIndex
    ) {
      throw new CrankError("nondeterminism_detected", "Recorded operation descriptor differs");
    }
    if (existing.resolution.status === "settled") {
      return {
        status: "resolved",
        outcome: structuredClone(existing.resolution.settlement.outcome),
        receipt: { ...existing.resolution.settlement.receipt, status: "duplicate" },
      };
    }
    if (descriptor.kind === "effect" || descriptor.kind === "record") {
      return authorizeExisting(draft, observed, existing);
    }
    const capability =
      existing.resolutionAuthority.kind === "attempt"
        ? draft.resolutionCapability(observed, existing, undefined)
        : existing.resolutionAuthority.capability;
    return {
      status: "pending",
      pullId: existing.pullId,
      reason: pendingReason(descriptor),
      resolutionCapability: capability,
    };
  }
  const task = draft.task(request.sessionId, request.taskId);
  if (
    task.lifecycle.status === "active" &&
    task.lifecycle.cancellation.type !== "none" &&
    task.lifecycle.cancellation.type !== "unwinding" &&
    request.actionIndex >= task.lifecycle.cancellation.frontier.actionIndex
  ) {
    throw new CrankError("cancellation_blocked");
  }
  // Ancestor freeze (REQ-021): no new work while a fork group is nonterminal.
  if (task.forkGroup !== undefined && task.forkGroup.status !== "resolved") {
    throw new CrankError("fork_group_open", "Task is frozen by an open fork group");
  }
  if (request.actionIndex !== task.nextActionIndex || request.pullIndex !== task.nextPullIndex) {
    throw new CrankError("nondeterminism_detected", "Task-local action or pull cursor mismatch");
  }
  if (
    descriptor.kind === "elicit" &&
    openElicitCount(draft.state, request.sessionId) >= MAX_OPEN_ELICITATIONS
  ) {
    throw new CrankError("checkpoint_bound_exceeded");
  }
  const policy = operationPolicy(task.program.manifest, descriptor);
  let effectiveDescriptor = descriptor;
  if (descriptor.kind === "wait" && descriptor.durationMs !== undefined) {
    effectiveDescriptor = {
      ...descriptor,
      notBefore: new Date(draft.context.nowMs + descriptor.durationMs).toISOString(),
    };
  }
  if (
    policy.inputDigest !== undefined &&
    (descriptor.kind === "effect" || descriptor.kind === "sample")
  ) {
    effectiveDescriptor = {
      ...descriptor,
      input: draft.parseSchema(policy.inputDigest, descriptor.input, "invalid_descriptor"),
    };
  }
  if (descriptor.kind === "elicit" && policy.contextDigest && descriptor.context !== undefined) {
    effectiveDescriptor = {
      ...descriptor,
      context: draft.parseSchema(policy.contextDigest, descriptor.context, "invalid_descriptor"),
    };
  }
  if (request.restoredFrontier !== undefined) {
    consumeRestoredFrontier(
      draft,
      request.sessionId,
      task,
      request.restoredFrontier,
      request.restoredFrontierStep,
    );
  }
  const pullId = stableTupleHash([
    "pull",
    request.sessionId,
    request.turnId,
    request.taskId,
    request.pullIndex,
  ]);
  const publicMessageId = isModelSampleDescriptor(descriptor)
    ? stableTupleHash(["sweatpants.public-assistant", pullId])
    : undefined;
  const pull: DraftPull = {
    pullId,
    request: {
      proposedDescriptorDigest: descriptorDigest,
      proposedDescriptor: descriptor,
      acceptedDescriptor: effectiveDescriptor,
      resultDescriptor: policy.resultDescriptor,
      resultSchemaDigest: policy.resultDescriptor.digest,
      maxOutcomeBytes: draft.maxOutcomeBytes,
      ...(publicMessageId === undefined ? {} : { publicMessageId }),
    },
    resolutionAuthority: executableDescriptor(effectiveDescriptor)
      ? {
          kind: "attempt",
          owner: effectiveDescriptor.kind === "record" ? "program" : "effect",
          audience: policy.audience,
        }
      : pendingResolutionAuthority(
          effectiveDescriptor,
          descriptor.kind === "elicit"
            ? (task.execution.elicitAudience ?? policy.audience)
            : policy.audience,
        ),
    attempts: [],
    acceptedFacts: {},
    resolution: { status: "open", revoked: false },
  };
  task.actions.push({
    kind: "pull",
    actionIndex: request.actionIndex,
    pullIndex: request.pullIndex,
    pull,
  });
  task.nextPullIndex += 1;
  draft.append(request.sessionId, task.execution.epoch, {
    type: "PullRequested",
    taskId: task.taskId,
    turnId: task.turnId,
    actionIndex: request.actionIndex,
    pullIndex: request.pullIndex,
    pullId,
    descriptor,
    descriptorDigest,
    ...(publicMessageId === undefined ? {} : { publicMessageId }),
  });
  if (executableDescriptor(effectiveDescriptor)) {
    const authorized = startAttempt(draft, task, pull);
    return {
      ...authorized,
      ...(request.restoredFrontier === undefined
        ? {}
        : { restoredFrontierConsumed: true as const }),
    };
  }
  const capability = draft.resolutionCapability(task, pull, undefined);
  if (pull.resolutionAuthority.kind === "participant") {
    pull.resolutionAuthority = { ...pull.resolutionAuthority, capability };
  } else if (pull.resolutionAuthority.kind === "clock") {
    pull.resolutionAuthority = { ...pull.resolutionAuthority, capability };
  } else if (pull.resolutionAuthority.kind === "child") {
    pull.resolutionAuthority = { ...pull.resolutionAuthority, capability };
  }
  return {
    status: "pending",
    pullId,
    reason: pendingReason(descriptor),
    resolutionCapability: capability,
    ...(request.restoredFrontier === undefined ? {} : { restoredFrontierConsumed: true as const }),
  };
}

function matchesModelPreparationOwner(
  task: TaskState,
  pull: PullState,
  expectedOwnerFence: string,
): boolean {
  const attempt = currentAttempt(pull);
  return attempt
    ? attempt.attemptId === expectedOwnerFence
    : pull.request.proposedDescriptor.kind === "sample" &&
        expectedOwnerFence === modelPullOwnerFence(pull.pullId, task.execution.epoch);
}

export function acceptPreparation(
  draft: DecisionDraft,
  request: AcceptPullPreparationRequest,
): AcceptPullPreparationResult {
  if (
    request.kind !== "model-context" ||
    request.fact.type !== "ModelContextPrepared" ||
    request.fact.taskId !== request.taskId ||
    request.fact.pullId !== request.pullId ||
    request.fact.executionId !== request.executionId
  ) {
    return { status: "identity_conflict" };
  }
  const found = findTaskPullById(draft.state, request.taskId, request.pullId);
  if (!found) {
    return { status: "pull_not_pending" };
  }
  const [sessionId, task, observed] = found;
  if (
    task.lifecycle.status !== "active" ||
    observed.resolution.status !== "open" ||
    observed.resolution.revoked
  ) {
    return { status: "pull_not_pending" };
  }
  if (!isModelSampleDescriptor(observed.request.proposedDescriptor)) {
    return { status: "identity_conflict" };
  }
  if (!matchesModelPreparationOwner(task, observed, request.expectedOwnerFence)) {
    return { status: "stale_owner" };
  }
  const digest = canonicalDigest(request.fact);
  if (observed.acceptedFacts.preparation) {
    return observed.acceptedFacts.preparationDigest === digest
      ? { status: "duplicate" }
      : {
          status: "identity_conflict",
          conflict: identityConflict(
            "model-context",
            `${request.executionId}/${request.taskId}/${request.pullId}`,
            digest,
            observed.acceptedFacts.preparationDigest ?? null,
          ),
        };
  }
  const pull = pullById(draft.task(sessionId, request.taskId), request.pullId);
  pull.acceptedFacts.preparation = structuredClone(request.fact) as NonNullable<
    DraftPull["acceptedFacts"]["preparation"]
  >;
  pull.acceptedFacts.preparationDigest = digest;
  draft.append(sessionId, task.execution.epoch, {
    type: "ModelContextPrepared",
    taskId: request.taskId,
    pullId: request.pullId,
    attemptId: request.expectedOwnerFence,
    fact: request.fact,
    preparationDigest: digest,
  });
  return { status: "accepted" };
}

export function acceptAssistantPartial(
  draft: DecisionDraft,
  request: AcceptAssistantPartialRequest,
): AcceptAssistantPartialResult {
  const found = findTaskPullById(draft.state, request.taskId, request.pullId);
  if (!found) {
    return { status: "pull_not_pending" };
  }
  const [sessionId, task, observed] = found;
  if (
    task.lifecycle.status !== "active" ||
    observed.resolution.status !== "open" ||
    observed.resolution.revoked
  ) {
    return { status: "pull_not_pending" };
  }
  if (!isModelSampleDescriptor(observed.request.proposedDescriptor)) {
    return { status: "identity_conflict" };
  }
  if (!matchesModelPreparationOwner(task, observed, request.expectedOwnerFence)) {
    return { status: "stale_owner" };
  }
  if (observed.acceptedFacts.preparation?.executionId !== request.executionId) {
    return { status: "identity_conflict" };
  }
  if (
    !observed.acceptedFacts.preparation ||
    observed.acceptedFacts.preparation.publicMessageId !== request.fact.messageId ||
    request.fact.text.length === 0 ||
    request.fact.text.length > 32_768
  ) {
    return { status: "identity_conflict" };
  }
  const digest = canonicalDigest(request.fact);
  if (observed.acceptedFacts.assistantPartial) {
    return observed.acceptedFacts.assistantPartialDigest === digest
      ? { status: "duplicate" }
      : {
          status: "identity_conflict",
          conflict: identityConflict(
            "assistant-partial",
            `${request.executionId}/${request.taskId}/${request.pullId}`,
            digest,
            observed.acceptedFacts.assistantPartialDigest ?? null,
          ),
        };
  }
  const pull = pullById(draft.task(sessionId, request.taskId), request.pullId);
  pull.acceptedFacts.assistantPartial = structuredClone(request.fact);
  pull.acceptedFacts.assistantPartialDigest = digest;
  draft.append(sessionId, task.execution.epoch, {
    type: "AssistantPartialAccepted",
    taskId: request.taskId,
    pullId: request.pullId,
    attemptId: request.expectedOwnerFence,
    fact: request.fact,
    factDigest: digest,
  });
  return { status: "accepted" };
}

export function resolvePull(
  draft: DecisionDraft,
  request: ResolveOperationRequest,
): ResolveOperationResult {
  let claims;
  try {
    claims = verifyResolutionCapability(
      request.capability,
      draft.context.keyring,
      request.audience,
    );
  } catch (error) {
    return {
      status: "rejected",
      code:
        error instanceof CrankError && error.code === "wrong_audience"
          ? "wrong_audience"
          : "invalid_resolution_capability",
    };
  }
  if (
    claims.journalId !== draft.context.journalIdentity.id ||
    claims.journalIncarnation !== draft.context.journalIdentity.incarnation
  ) {
    return { status: "rejected", code: "invalid_resolution_capability" };
  }
  if (!draft.state.sessions.get(claims.sessionId)?.execution.tasks.has(claims.taskId)) {
    return { status: "rejected", code: "pull_not_found" };
  }
  const observedTask = draft.readTask(claims.sessionId, claims.taskId);
  let observedPull: PullState;
  try {
    observedPull = pullById(observedTask, claims.pullId);
  } catch {
    return { status: "rejected", code: "pull_not_found" };
  }
  const observedAttempt =
    claims.attemptId === "none"
      ? undefined
      : observedPull.attempts.find((candidate) => candidate.attemptId === claims.attemptId);
  const reject = (): Extract<ResolveOperationResult, { status: "rejected" }> | undefined => {
    if (
      observedPull.request.proposedDescriptorDigest !== claims.descriptorDigest ||
      observedPull.request.resultSchemaDigest !== claims.resultSchemaDigest
    ) {
      return { status: "rejected", code: "invalid_resolution_capability" };
    }
    if (
      observedPull.resolution.revoked ||
      (claims.attemptId !== "none" && (!observedAttempt || observedAttempt.status === "revoked"))
    ) {
      return { status: "rejected", code: "capability_revoked" };
    }
    if (observedTask.lifecycle.status !== "active") {
      return { status: "rejected", code: "task_terminal" };
    }
    return undefined;
  };
  const early = reject();
  if (early) {
    return early;
  }
  let discardedPartial:
    | "schema_validation_failed"
    | "payload_too_large"
    | "schema_version_unavailable"
    | undefined;
  let outcome = snapshotOutcome(request.outcome);
  if (outcome.status === "cancelled" && outcome.partial !== undefined) {
    const definition =
      observedPull.request.proposedDescriptor.kind === "effect"
        ? observedTask.program.manifest.effects[observedPull.request.proposedDescriptor.name]
        : undefined;
    let partial: Json | undefined;
    let reason: "schema_validation_failed" | "payload_too_large" | "schema_version_unavailable" =
      "schema_validation_failed";
    if (definition?.cancellation) {
      const validated = parseRegisteredSchema(
        draft.context.schemas,
        definition.cancellation.partialSchema.digest,
        outcome.partial,
      );
      if (validated.status === "ok") {
        try {
          assertInlineSize(
            validated.value,
            Math.min(claims.maxOutcomeBytes, observedPull.request.maxOutcomeBytes),
          );
          partial = validated.value;
        } catch {
          reason = "payload_too_large";
        }
      } else if (validated.status === "unavailable") {
        reason = "schema_version_unavailable";
      }
    }
    if (partial === undefined) {
      discardedPartial = reason;
      outcome = { status: "cancelled" };
    } else {
      outcome = { status: "cancelled", partial };
    }
  } else if (outcome.status === "ok") {
    if (observedPull.request.proposedDescriptor.kind === "elicit") {
      const envelope = parseProgramElicitResult(outcome.value);
      if (!envelope) {
        return { status: "rejected", code: "schema_validation_failed" };
      }
      if (envelope.action === "accept") {
        const validated = parseRegisteredSchema(
          draft.context.schemas,
          observedPull.request.resultSchemaDigest,
          envelope.content,
        );
        if (validated.status === "unavailable") {
          return { status: "rejected", code: "schema_version_unavailable" };
        }
        if (validated.status !== "ok") {
          return { status: "rejected", code: "schema_validation_failed" };
        }
        outcome = { status: "ok", value: { action: "accept", content: validated.value } };
      } else {
        const reason = sanitizeCancellationReason(
          typeof envelope.reason === "string" ? envelope.reason : undefined,
        );
        outcome = {
          status: "ok",
          value: { action: envelope.action, ...(reason === undefined ? {} : { reason }) },
        };
      }
    } else {
      const validated = parseRegisteredSchema(
        draft.context.schemas,
        observedPull.request.resultSchemaDigest,
        outcome.value,
      );
      if (validated.status === "unavailable") {
        return { status: "rejected", code: "schema_version_unavailable" };
      }
      if (validated.status !== "ok") {
        return { status: "rejected", code: "schema_validation_failed" };
      }
      outcome = { status: "ok", value: validated.value };
    }
  }
  let encodedOutcome: string;
  try {
    encodedOutcome = encodeInlineJson(
      outcome,
      Math.min(claims.maxOutcomeBytes, observedPull.request.maxOutcomeBytes),
    );
  } catch {
    return { status: "rejected", code: "payload_too_large" };
  }
  if (
    observedPull.request.acceptedDescriptor.kind === "wait" &&
    outcome.status === "ok" &&
    observedPull.request.acceptedDescriptor.notBefore &&
    draft.context.nowMs < Date.parse(observedPull.request.acceptedDescriptor.notBefore)
  ) {
    return { status: "rejected", code: "wait_not_due" };
  }
  const post = reject();
  if (post) {
    return post;
  }
  const digest = sha256(encodedOutcome);
  if (observedPull.resolution.status === "settled") {
    if (observedPull.resolution.settlement.outcomeDigest === digest) {
      return {
        status: "duplicate",
        receipt: { ...observedPull.resolution.settlement.receipt, status: "duplicate" },
      };
    }
    return {
      status: "rejected",
      code: resolutionConflictCode(observedAttempt),
    };
  }
  const task = draft.task(claims.sessionId, claims.taskId);
  const pull = pullById(task, claims.pullId);
  const attempt =
    claims.attemptId === "none"
      ? undefined
      : pull.attempts.find((candidate) => candidate.attemptId === claims.attemptId);
  if (discardedPartial !== undefined) {
    draft.append(claims.sessionId, undefined, {
      type: "CancellationPartialDiscarded",
      taskId: task.taskId,
      pullId: pull.pullId,
      reason: discardedPartial,
    });
  }
  const offset = draft.append(claims.sessionId, undefined, {
    type: "PullResolved",
    taskId: task.taskId,
    pullId: pull.pullId,
    ...(attempt ? { attemptId: attempt.attemptId } : {}),
    outcome,
    outcomeDigest: digest,
  });
  if (attempt) {
    attempt.status = "completed";
    for (const competitor of pull.attempts) {
      if (
        competitor === attempt ||
        competitor.status === "revoked" ||
        competitor.status === "superseded"
      ) {
        continue;
      }
      competitor.status = "superseded";
      draft.append(claims.sessionId, undefined, {
        type: "AttemptSuperseded",
        taskId: task.taskId,
        pullId: pull.pullId,
        attemptId: competitor.attemptId,
        winnerAttemptId: attempt.attemptId,
      });
    }
  }
  const receipt: ResolutionReceipt = {
    sessionId: taskOriginSession(draft.state, task.taskId),
    taskId: task.taskId,
    pullId: pull.pullId,
    resolutionOffset: offset,
    outcomeDigest: digest,
    status: "accepted",
  };
  pull.resolution = {
    status: "settled",
    revoked: pull.resolution.revoked,
    settlement: { outcome, outcomeDigest: digest, receipt },
  };
  task.nextActionIndex = Math.max(task.nextActionIndex, pullActionIndex(task, pull) + 1);
  if (
    task.lifecycle.status === "active" &&
    task.lifecycle.cancellation.type === "settling_pull" &&
    task.lifecycle.cancellation.pullId === pull.pullId
  ) {
    task.lifecycle.cancellation = {
      type: "requested",
      commandId: task.lifecycle.cancellation.commandId,
      ...(task.lifecycle.cancellation.reason === undefined
        ? {}
        : { reason: task.lifecycle.cancellation.reason }),
      frontier: task.lifecycle.cancellation.frontier,
    };
  }
  endLiveLease(draft, claims.sessionId, task, "settled");
  draft.session(claims.sessionId).control.runnable = true;
  return { status: "accepted", receipt };
}

export function appendEmission(
  draft: DecisionDraft,
  request: AppendEmissionRequest,
): EmissionReceipt {
  const observed = draft.readTask(request.sessionId, request.taskId);
  draft.assertProgram(request.programCapability, observed, request.sessionId);
  draft.assertActive(observed);
  if (!observed.program.manifest.capabilities.durableEmissions) {
    throw new CrankError("invalid_descriptor", "Program does not declare durable emissions");
  }
  const encoded = canonicalSnapshot(request.descriptor);
  const descriptor = encoded.value;
  const digest = sha256(encoded.canonical);
  const existing = emissionByAction(observed, request.actionIndex);
  if (existing) {
    if (existing.descriptorDigest !== digest) {
      throw new CrankError("nondeterminism_detected", "Emission payload differs");
    }
    return { ...existing.receipt, duplicate: true };
  }
  if (request.actionIndex !== observed.nextActionIndex) {
    throw new CrankError("nondeterminism_detected", "Emission action cursor mismatch");
  }
  const encodedPayload = encodeInlineJson(descriptor.payload, draft.maxOutcomeBytes);
  const payloadBytes = new TextEncoder().encode(encodedPayload).byteLength;
  const count = observed.acceptedEmissionCount + 1;
  const total = observed.cumulativeEmissionBytes + payloadBytes;
  if (
    (observed.emissionPolicy?.maxEmissionsPerTask !== undefined &&
      count > observed.emissionPolicy.maxEmissionsPerTask) ||
    (observed.emissionPolicy?.maxCumulativeEmissionBytes !== undefined &&
      total > observed.emissionPolicy.maxCumulativeEmissionBytes)
  ) {
    throw new CrankError("emission_quota_exceeded");
  }
  const task = draft.task(request.sessionId, request.taskId);
  if (request.restoredFrontier !== undefined) {
    consumeRestoredFrontier(
      draft,
      request.sessionId,
      task,
      request.restoredFrontier,
      request.restoredFrontierStep,
    );
  }
  const emissionIndex = task.nextEmissionIndex;
  const offset = draft.append(request.sessionId, task.execution.epoch, {
    type: "DurableEmission",
    taskId: task.taskId,
    actionIndex: request.actionIndex,
    emissionIndex,
    descriptor,
    descriptorDigest: digest,
  });
  const receipt: EmissionReceipt = {
    offset,
    eventId: `journal:${request.sessionId}:${offset}`,
    duplicate: false,
    ...(request.restoredFrontier === undefined ? {} : { restoredFrontierConsumed: true as const }),
  };
  task.actions.push({
    kind: "emission",
    actionIndex: request.actionIndex,
    emissionIndex,
    descriptorDigest: digest,
    receipt,
  });
  task.nextEmissionIndex += 1;
  task.nextActionIndex += 1;
  task.acceptedEmissionCount = count;
  task.cumulativeEmissionBytes = total;
  return receipt;
}

export function completeTask(
  kernel: AuthorityKernel,
  request: CompleteTaskRequest,
): CompleteTaskResult {
  const { draft } = kernel;
  const observed = draft.readTask(request.sessionId, request.taskId);
  draft.assertProgram(request.programCapability, observed, request.sessionId);
  const proposed = snapshotOutcome(request.outcome);
  let outcome: OperationOutcome =
    observed.lifecycle.status === "active" && observed.lifecycle.cancellation.type === "unwinding"
      ? { status: "cancelled" }
      : proposed;
  if (outcome.status === "ok") {
    // Program-authored values may be refused by policy; refusals are data,
    // not exceptions (mirrors resolve-pull / validate-elicit-response).
    let value: Json;
    try {
      value = draft.parseSchema(
        observed.program.manifest.outputSchema.digest,
        outcome.value,
        "schema_validation_failed",
      );
    } catch (error) {
      if (!(error instanceof CrankError) || error.code !== "schema_validation_failed") {
        throw error;
      }
      return { status: "rejected", code: error.code, message: error.message };
    }
    outcome = { status: "ok", value };
  }
  let encodedOutcome: string;
  try {
    encodedOutcome = encodeInlineJson(outcome, draft.maxOutcomeBytes);
  } catch (error) {
    if (
      outcome.status !== "ok" ||
      !(error instanceof CrankError) ||
      error.code !== "payload_too_large"
    ) {
      throw error;
    }
    return { status: "rejected", code: error.code, message: error.message };
  }
  if (observed.lifecycle.status === "closed" || observed.lifecycle.status === "cancelled") {
    const receipt = observed.lifecycle.receipt;
    if (encodeCanonicalJson(observed.lifecycle.outcome) !== encodedOutcome) {
      throw new CrankError("nondeterminism_detected", "Task completion differs");
    }
    return { status: "duplicate", receipt: { ...receipt, duplicate: true } };
  }
  draft.assertActive(observed);
  if (request.actionIndex !== observed.nextActionIndex) {
    throw new CrankError("history_not_exhausted");
  }
  if (
    observed.actions.some(
      (action) => action.kind === "pull" && action.pull.resolution.status === "open",
    )
  ) {
    throw new CrankError("history_not_exhausted", "Task has an unresolved pull");
  }
  const task = draft.task(request.sessionId, request.taskId);
  if (request.restoredFrontier !== undefined) {
    consumeRestoredFrontier(
      draft,
      request.sessionId,
      task,
      request.restoredFrontier,
      request.restoredFrontierStep,
    );
  }
  const offset = draft.append(request.sessionId, task.execution.epoch, {
    type: "TaskClosed",
    taskId: task.taskId,
    outcome,
  });
  const receipt: TaskCloseReceipt = {
    offset,
    duplicate: false,
    ...(request.restoredFrontier === undefined ? {} : { restoredFrontierConsumed: true as const }),
  };
  const activeLifecycle = task.lifecycle.status === "active" ? task.lifecycle : undefined;
  const commandId =
    activeLifecycle && activeLifecycle.cancellation.type !== "none"
      ? activeLifecycle.cancellation.commandId
      : stableTupleHash(["cancel-command", request.sessionId, request.taskId]);
  task.lifecycle =
    outcome.status === "cancelled"
      ? {
          status: "cancelled",
          outcome: outcome as Extract<OperationOutcome, { status: "cancelled" }>,
          receipt,
          commandId,
        }
      : { status: "closed", outcome, receipt };
  kernel.settleParent(request.sessionId, task, outcome);
  return { status: "accepted", receipt };
}

function executableDescriptor(descriptor: DurableOperationDescriptor): boolean {
  return descriptor.kind === "effect" || descriptor.kind === "record";
}
function pendingResolutionAuthority(
  descriptor: DurableOperationDescriptor,
  audience: string,
): ResolutionAuthority {
  const policy = pullKindPolicy(descriptor.kind);
  if (!policy?.resolutionAuthority) {
    throw new CrankError("invalid_descriptor");
  }
  return policy.resolutionAuthority(descriptor, audience);
}

function startAttempt(
  draft: DecisionDraft,
  task: DraftTask,
  pull: DraftPull,
): Extract<ReserveOperationResult, { status: "authorized" }> {
  const attemptIndex = pull.attempts.length;
  const attemptId = `${pull.pullId}:attempt-${attemptIndex}`;
  const capability = draft.resolutionCapability(task, pull, attemptId);
  pull.attempts.push({ attemptId, attemptIndex, capability, status: "started" });
  draft.append(taskOriginSession(draft.state, task.taskId), task.execution.epoch, {
    type: "AttemptStarted",
    taskId: task.taskId,
    pullId: pull.pullId,
    attemptId,
    attemptIndex,
  });
  const descriptor = installedOrRecordedDescriptor(pull.request.acceptedDescriptor);
  pull.resolutionAuthority = {
    kind: "attempt",
    owner: descriptor.kind === "record" ? "program" : "effect",
    audience: pullAudience(pull),
  };
  return {
    status: "authorized",
    pullId: pull.pullId,
    attemptId,
    descriptor,
    ...(descriptor.kind === "effect"
      ? {
          effectContractDigest: effectDigestForPull(task.program.manifest, descriptor),
          effectDefinition: structuredClone(task.program.manifest.effects[descriptor.name]!),
        }
      : {}),
    resolutionCapability: capability,
  };
}

function authorizeExisting(
  draft: DecisionDraft,
  task: TaskState,
  pull: PullState,
): Extract<ReserveOperationResult, { status: "authorized" }> {
  const active = currentAttempt(pull);
  if (active) {
    return {
      status: "authorized",
      pullId: pull.pullId,
      attemptId: active.attemptId,
      descriptor: installedOrRecordedDescriptor(pull.request.acceptedDescriptor),
      ...(pull.request.acceptedDescriptor.kind === "effect"
        ? {
            effectContractDigest: effectDigestForPull(
              task.program.manifest,
              pull.request.acceptedDescriptor,
            ),
            effectDefinition: structuredClone(
              task.program.manifest.effects[pull.request.acceptedDescriptor.name]!,
            ),
          }
        : {}),
      resolutionCapability: active.capability,
    };
  }
  const owned = draft.task(taskOriginSession(draft.state, task.taskId), task.taskId);
  return startAttempt(draft, owned, pullById(owned, pull.pullId));
}

function openElicitCount(state: AuthorityState, sessionId: string): number {
  let count = 0;
  const session = state.sessions.get(sessionId);
  if (!session) {
    return 0;
  }
  for (const task of session.execution.tasks.values()) {
    if (task.lifecycle.status === "active") {
      for (const action of task.actions) {
        if (
          action.kind === "pull" &&
          action.pull.request.proposedDescriptor.kind === "elicit" &&
          action.pull.resolution.status === "open" &&
          !action.pull.resolution.revoked
        ) {
          count++;
        }
      }
    }
  }
  return count;
}
