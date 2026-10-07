import {
  CrankError,
  type DurableAllDescriptor,
  type DurableChildDescriptor,
  type DeliveryMandate,
  type DurableRaceDescriptor,
} from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import { stableTupleHash, canonicalDigest, canonicalJson } from "@sweatpants/foundation";
import type { DecisionDraft } from "./decision-draft.ts";
import type { AuthorityKernel } from "../state/authority-transaction.ts";
import type { DeepMutable, DraftTask } from "./decision-state.ts";
import { pullById } from "./decision-state.ts";
import {
  assertForkPolicyPairing,
  beginForkGroupCancellation,
  drainForkGroup,
  forceOrphanForkGroupResolution,
  forkGroupIdFor,
  forkGroupOutcome,
  peerDeliveryCorrelator,
  peerLossOutcome,
  resolveForkDeadline,
  type ForkGroupState,
  type ForkPolicy,
} from "../forest/fork-group.ts";
import { signCapability, verifyDeliveryMandate } from "../contract/capabilities.ts";
import { currentForkGroupRevision, planForestReplay, strandHead } from "../forest/forest-replay.ts";
import type {
  BindDeliveryMandateRequest,
  BindDeliveryMandateResult,
  BreachForkGroupRequest,
  BreachForkGroupResult,
  CommitPeerDelegationRequest,
  CommitPeerDelegationResult,
  CommitPeerEvidenceRequest,
  CommitPeerEvidenceResult,
  ForceOrphanForkGroupRequest,
  ForceOrphanForkGroupResult,
  OpenForkGroupRequest,
  OpenForkGroupResult,
  ReportPeerLossRequest,
  ReportPeerLossResult,
  ReserveDelegatedPeerSampleRequest,
  ReserveDelegatedPeerSampleResult,
} from "../contract/authority-types.ts";

type ForkDescriptorPayload =
  | (DurableAllDescriptor & { readonly children: readonly DurableChildDescriptor[] })
  | (DurableRaceDescriptor & { readonly children: readonly DurableChildDescriptor[] });

/**
 * Atomic fork-group admission (REQ-021/023/030). Opens the group row and
 * every member row in one commit; identical retries return the recorded
 * opening; a second distinct group on a nonterminal pull is refused.
 */
export function openForkGroup(
  kernel: AuthorityKernel,
  request: OpenForkGroupRequest,
): OpenForkGroupResult {
  const { draft } = kernel;
  const parent = draft.task(request.sessionId, request.parentTaskId);
  draft.assertActive(parent);
  const pull = pullById(parent, request.parentPullId);
  const kind = pull.request.acceptedDescriptor.kind;
  if (kind !== "all" && kind !== "race") {
    throw new CrankError("invalid_descriptor", "Parent pull is not a fork descriptor");
  }
  const descriptor = pull.request.acceptedDescriptor as unknown as ForkDescriptorPayload;
  const descriptorDigest = pull.request.proposedDescriptorDigest;
  const existing = parent.forkGroup;
  if (existing !== undefined && existing.status !== "resolved") {
    if (existing.pullId === pull.pullId && existing.descriptorDigest === descriptorDigest) {
      return {
        status: "duplicate",
        groupId: existing.groupId,
        deadlineMs: existing.deadlineMs,
        memberTaskIds: existing.members.map((member) => member.taskId),
      };
    }
    throw new CrankError("fork_group_open", "Task already has an open fork group");
  }
  const policy: ForkPolicy =
    kind === "all"
      ? { mode: "all", supervision: "one_for_all" }
      : { mode: "race", supervision: "first_success" };
  assertForkPolicyPairing(policy);
  if (request.members.length !== descriptor.children.length) {
    throw new CrankError("nondeterminism_detected", "Fork members differ from the descriptor");
  }
  for (const [index, member] of request.members.entries()) {
    const expected = descriptor.children[index]!;
    if (
      expected.id !== member.child.id ||
      expected.version !== member.child.version ||
      expected.digest !== member.child.digest ||
      canonicalJson(expected.input) !== canonicalJson(member.child.input)
    ) {
      throw new CrankError("nondeterminism_detected", "Fork member differs from the descriptor");
    }
  }
  // Closed durability union with declared peer sampling (REQ-035, REQ-042):
  // admission fails closed on unknown classes and missing declarations.
  for (const child of descriptor.children) {
    const durability = child.durability;
    if (durability === undefined || durability.kind === "crank_native") continue;
    if (durability.kind === "peer_hosted") {
      if (
        typeof durability.peer !== "string" ||
        durability.peer.length === 0 ||
        (durability.sampling !== "delegated" && durability.sampling !== "private")
      ) {
        throw new CrankError(
          "invalid_descriptor",
          "Peer-hosted members require a declared sampling mode",
        );
      }
      continue;
    }
    throw new CrankError("invalid_descriptor", "Unknown member durability class");
  }
  const deadlineMs = resolveForkDeadline(descriptor.expiry, parent.deadlineMs, draft.context.nowMs);
  const groupId = forkGroupIdFor(parent.taskId, pull.pullId);
  const baseOrdinal = [...draft.session(request.sessionId).execution.tasks.values()].filter(
    (task) => task.origin.kind === "child" && task.origin.invokedBy.taskId === parent.taskId,
  ).length;
  const memberTaskIds = request.members.map(
    (_, index) => `${parent.taskId}.${baseOrdinal + index}`,
  );
  const group: DeepMutable<ForkGroupState> = {
    revision: 1,
    groupId,
    parentTaskId: parent.taskId,
    pullId: pull.pullId,
    descriptorDigest,
    policy,
    deadlineMs,
    members: request.members.map((_, index) => {
      const durability = descriptor.children[index]!.durability;
      return durability?.kind === "peer_hosted"
        ? {
            ordinal: index,
            taskId: memberTaskIds[index]!,
            durability: "peer_hosted" as const,
            peer: durability.peer,
            sampling: durability.sampling,
          }
        : { ordinal: index, taskId: memberTaskIds[index]!, durability: "crank_native" as const };
    }),
    status: "open",
  };
  for (const [index, member] of request.members.entries()) {
    const durability = descriptor.children[index]!.durability;
    kernel.openTask({
      sessionId: request.sessionId,
      turnId: request.turnId,
      taskId: memberTaskIds[index]!,
      manifest: member.manifest,
      input: member.child.input,
      executionEpoch: request.executionEpoch,
      attachmentId: "unattached-child",
      // Peer member audiences are derived locally, never taken from
      // peer-supplied claims (REQ-041).
      audience: durability?.kind === "peer_hosted" ? `peer:${durability.peer}` : request.audience,
      ...(parent.execution.elicitAudience === undefined
        ? {}
        : { elicitAudience: parent.execution.elicitAudience }),
      ...(parent.execution.catalog === undefined
        ? {}
        : { catalog: parent.execution.catalog, catalogDigest: parent.execution.catalogDigest! }),
      ...(member.route === undefined ? {} : { route: member.route }),
      parentTaskId: parent.taskId,
      parentPullId: pull.pullId,
      expiryPolicy: { kind: "at", atMs: deadlineMs },
    });
  }
  parent.forkGroup = group;
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "ForkGroupOpened",
    taskId: parent.taskId,
    pullId: pull.pullId,
    groupId,
    policy,
    deadlineMs,
    memberTaskIds,
    descriptorDigest,
  });
  draft.session(request.sessionId).control.runnable = true;
  return { status: "opened", groupId, deadlineMs, memberTaskIds };
}

/**
 * Clock-driven expiry breach (REQ-031): commits an auditable breach record,
 * starts leaves-first member cancellation, and resolves `expired` only once
 * every member is terminal. Loses to an earlier resolution with a typed
 * `fork_group_terminal` rejection (REQ-032); a breach committed first makes
 * later member successes member history only.
 */
export function breachForkGroup(
  kernel: AuthorityKernel,
  request: BreachForkGroupRequest,
): BreachForkGroupResult {
  const { draft } = kernel;
  const parent = draft.task(request.sessionId, request.taskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== request.groupId) {
    throw new CrankError("invalid_journal", "Unknown fork group");
  }
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  if (draft.context.nowMs < group.deadlineMs) {
    throw new CrankError("fork_group_unexpired", "Fork group deadline has not elapsed");
  }
  let cancelMembers: readonly string[] = [];
  if (group.breachedAtMs === undefined) {
    group.breachedAtMs = draft.context.nowMs;
    group.revision = (group.revision ?? 0) + 1;
    draft.append(request.sessionId, parent.execution.epoch, {
      type: "ForkGroupBreached",
      taskId: parent.taskId,
      groupId: group.groupId,
      deadlineMs: group.deadlineMs,
      breachedAtMs: draft.context.nowMs,
    });
    cancelMembers = beginForkGroupCancellation(group, "expiry");
    for (const memberTaskId of cancelMembers) {
      kernel.requestCancellation(request.sessionId, memberTaskId, "fork_group_expired");
    }
  }
  const resolution = drainForkGroup(group);
  if (resolution !== undefined) {
    draft.append(request.sessionId, parent.execution.epoch, {
      type: "ForkGroupResolved",
      taskId: parent.taskId,
      pullId: group.pullId,
      groupId: group.groupId,
      terminal: resolution,
      terminalDigest: canonicalDigest(resolution),
    });
    kernel.settlePull(
      request.sessionId,
      parent,
      pullById(parent, group.pullId),
      parent.execution.epoch,
      forkGroupOutcome(resolution),
    );
  }
  return {
    groupId: group.groupId,
    cancelMembers,
    ...(resolution === undefined ? {} : { resolution }),
  };
}

/**
 * Separately authorized force-orphan of a stuck group (REQ-034). Honest:
 * records `orphaned` and never fabricates another ending; nonterminal
 * members are orphaned in place; later member messages stay opaque evidence.
 */
export function forceOrphanForkGroup(
  kernel: AuthorityKernel,
  request: ForceOrphanForkGroupRequest,
): ForceOrphanForkGroupResult {
  const { draft } = kernel;
  const parent = draft.task(request.sessionId, request.taskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== request.groupId) {
    throw new CrankError("invalid_journal", "Unknown fork group");
  }
  if (group.status !== "cancelling") {
    throw new CrankError(
      group.status === "resolved" ? "fork_group_terminal" : "fork_group_not_cancelling",
      "Force-orphan requires a stuck cancelling fork group",
    );
  }
  const resolution = forceOrphanForkGroupResolution(group, request.reason);
  for (const member of group.members) {
    if (member.terminal !== undefined) continue;
    const memberTask = draft.task(request.sessionId, member.taskId);
    if (memberTask.lifecycle.status !== "active") continue;
    memberTask.lifecycle = { status: "orphaned", reason: "cleanup_stuck" };
    draft.append(request.sessionId, memberTask.execution.epoch, {
      type: "TaskOrphaned",
      taskId: member.taskId,
      reason: "cleanup_stuck",
    });
  }
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "ForkGroupOrphaned",
    taskId: parent.taskId,
    pullId: group.pullId,
    groupId: group.groupId,
    reason: request.reason,
  });
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "ForkGroupResolved",
    taskId: parent.taskId,
    pullId: group.pullId,
    groupId: group.groupId,
    terminal: resolution,
    terminalDigest: canonicalDigest(resolution),
  });
  kernel.settlePull(
    request.sessionId,
    parent,
    pullById(parent, group.pullId),
    parent.execution.epoch,
    forkGroupOutcome(resolution),
  );
  return { resolution };
}

function peerMemberOf(
  group: DeepMutable<ForkGroupState>,
  memberTaskId: string,
): DeepMutable<ForkGroupState>["members"][number] {
  const member = group.members.find((entry) => entry.taskId === memberTaskId);
  if (member === undefined) {
    throw new CrankError("invalid_journal", `Task ${memberTaskId} is not a fork group member`);
  }
  if (member.durability !== "peer_hosted") {
    throw new CrankError("invalid_descriptor", `Member ${memberTaskId} is not peer-hosted`);
  }
  return member;
}

function groupForRequest(
  draft: DecisionDraft,
  sessionId: string,
  taskId: string,
  groupId: string,
): { parent: DraftTask; group: DeepMutable<ForkGroupState> } {
  const parent = draft.task(sessionId, taskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== groupId) {
    throw new CrankError("invalid_journal", "Unknown fork group");
  }
  return { parent, group };
}

export function bindDeliveryMandate(
  draft: DecisionDraft,
  request: BindDeliveryMandateRequest,
): BindDeliveryMandateResult {
  if (
    !request.ownerId ||
    !Number.isSafeInteger(request.leaseDurationMs) ||
    request.leaseDurationMs < 1 ||
    request.leaseDurationMs > 300_000 ||
    request.placement.route.kind !== "peer"
  ) {
    throw new CrankError("invalid_command", "Invalid peer delivery lease request");
  }
  const ready = request.ready;
  const session = draft.session(ready.address.sessionId);
  const task = draft.task(ready.address.sessionId, ready.address.taskId);
  draft.assertActive(task);
  const parentTaskId = ready.groupContext.parentTaskId;
  const groupId = ready.groupContext.groupId;
  if (parentTaskId === undefined || groupId === undefined) {
    throw new CrankError("invalid_descriptor", "Peer target lacks fork-group context");
  }
  const parent = draft.task(ready.address.sessionId, parentTaskId);
  const group = parent.forkGroup;
  if (group === undefined || group.groupId !== groupId || group.status === "resolved") {
    return { status: "stale", mismatch: "fork_group_revision" };
  }
  const member = peerMemberOf(group, task.taskId);
  const head = strandHead(task);
  if (
    head.digest !== request.expected.strandHeadDigest ||
    ready.evidenceHead.digest !== request.expected.strandHeadDigest ||
    ready.frontierProof.strandHeadDigest !== request.expected.strandHeadDigest
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
  if (
    groupRevision !== request.expected.forkGroupRevision ||
    ready.frontierProof.groupRevision !== groupRevision
  ) {
    return { status: "stale", mismatch: "fork_group_revision" };
  }
  const planned = planForestReplay(
    draft.state,
    ready.address.sessionId,
    draft.context.journalHeadId,
    draft.context.nowMs,
  );
  if (!planned.peers.some((candidate) => candidate.address.taskId === task.taskId)) {
    return { status: "stale", mismatch: "strand_head" };
  }

  task.execution.epoch += 1;
  task.execution.attachmentId = request.attachmentId;
  const expiresAtMs = draft.context.nowMs + request.leaseDurationMs;
  const correlator =
    ready.deliveryCursor.correlator ?? peerDeliveryCorrelator(group.groupId, member.taskId);
  task.execution.liveLease = {
    ownerId: request.ownerId,
    epoch: task.execution.epoch,
    expiresAtMs,
    attachmentId: request.attachmentId,
    strandHeadDigest: head.digest,
    forkGroupRevision: groupRevision,
    frontierDigest: head.digest,
  };
  draft.append(ready.address.sessionId, task.execution.epoch, {
    type: "AdvancementBound",
    taskId: task.taskId,
    ownerId: request.ownerId,
    leaseEpoch: task.execution.epoch,
    expiresAtMs,
    strandHeadDigest: head.digest,
    forkGroupRevision: groupRevision,
    frontierDigest: head.digest,
  });
  const deliveryCapability = mintDeliveryCapability(
    draft,
    ready.address.sessionId,
    parent,
    group,
    member.taskId,
    correlator,
    member.peer!,
  );
  const mandate: DeliveryMandate = {
    kind: "delivery_mandate",
    address: structuredClone(ready.address),
    strand: ready.strand,
    placement: structuredClone(request.placement),
    attachment: {
      attachmentId: request.attachmentId,
      boundAtRevision: session.control.revision,
    },
    groupContext: structuredClone(ready.groupContext),
    lease: { ownerId: request.ownerId, epoch: task.execution.epoch, expiresAtMs },
    boundFrontier: {
      strandHeadDigest: head.digest,
      groupRevision,
    },
    deliveryCursor: { correlator },
    deliveryCapability,
  };
  session.control.runnable = false;
  return { status: "bound", mandate };
}

function mintDeliveryCapability(
  draft: DecisionDraft,
  sessionId: string,
  parent: DraftTask,
  group: DeepMutable<ForkGroupState>,
  memberTaskId: string,
  correlator: string,
  peer: string,
): string {
  return signCapability(
    {
      journalId: draft.context.journalIdentity.id,
      journalIncarnation: draft.context.journalIdentity.incarnation,
      sessionId,
      taskId: parent.taskId,
      groupId: group.groupId,
      memberTaskId,
      correlator,
      audience: `peer:${peer}`,
      permissions: ["deliver"],
      // Deterministic: duplicate delegation retries mint the identical
      // mandate without consuming journal nonce state.
      nonce: stableTupleHash(["delivery-mandate", correlator]),
    },
    draft.context.keyring,
  );
}

/**
 * Journal-first peer delegation (REQ-038): the delivery record commits before
 * any send; the correlator is deterministic, so retries reuse it and peers
 * dedupe by it (REQ-039). The returned DeliveryMandate confers proposal
 * rights only (REQ-074).
 */
export function commitPeerDelegation(
  draft: DecisionDraft,
  request: CommitPeerDelegationRequest,
): CommitPeerDelegationResult {
  const { sessionId, parent, group, member, correlator } = deliveryContext(draft, request.mandate);
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  if (member.delegationCorrelator !== undefined) {
    if (member.delegationCorrelator !== correlator) {
      throw new CrankError("nondeterminism_detected", "Peer delegation correlator differs");
    }
    return { status: "duplicate", correlator };
  }
  member.delegationCorrelator = correlator;
  group.revision = (group.revision ?? 0) + 1;
  draft.append(sessionId, parent.execution.epoch, {
    type: "PeerDelegationCommitted",
    taskId: parent.taskId,
    groupId: group.groupId,
    memberTaskId: member.taskId,
    correlator,
    peer: member.peer!,
    deadlineMs: group.deadlineMs,
  });
  draft.session(sessionId).control.runnable = true;
  return { status: "committed", correlator };
}

/**
 * Closes a peer member from external evidence. Invariant P (REQ-075): the
 * member row holds a structural task and evidence only — no local attempt
 * ever exists on it, and the evidence commits through the ordinary group
 * reducer so supervision stays exact (REQ-043).
 */
function closePeerMember(
  kernel: AuthorityKernel,
  mandate: DeliveryMandate,
  correlator: string,
  outcome: OperationOutcome,
): void {
  const { draft } = kernel;
  const { sessionId, member } = deliveryContext(draft, mandate, correlator);
  if (member.delegationCorrelator !== correlator) {
    throw new CrankError("invalid_delivery_mandate", "Unknown delivery correlator");
  }
  const memberTask = draft.task(sessionId, member.taskId);
  if (memberTask.lifecycle.status !== "active") {
    // First-committed-wins (REQ-032): the accepted fact is never rewritten.
    throw new CrankError("fork_member_terminal", "Peer member is already terminal");
  }
  const offset = draft.append(sessionId, memberTask.execution.epoch, {
    type: "TaskClosed",
    taskId: member.taskId,
    outcome,
  });
  memberTask.lifecycle =
    outcome.status === "cancelled"
      ? {
          status: "cancelled",
          outcome,
          receipt: { offset, duplicate: false },
          commandId: stableTupleHash(["peer-cancel", correlator]),
        }
      : { status: "closed", outcome, receipt: { offset, duplicate: false } };
  delete memberTask.execution.liveLease;
  kernel.settleParent(sessionId, memberTask, outcome);
}

function deliveryContext(
  draft: DecisionDraft,
  mandate: DeliveryMandate,
  expectedCorrelator?: string,
): {
  sessionId: string;
  parent: DraftTask;
  group: DeepMutable<ForkGroupState>;
  member: DeepMutable<ForkGroupState>["members"][number];
  correlator: string;
} {
  const sessionId = mandate.address.sessionId;
  const parentTaskId = mandate.groupContext.parentTaskId;
  const groupId = mandate.groupContext.groupId;
  const correlator = mandate.deliveryCursor.correlator;
  if (parentTaskId === undefined || groupId === undefined || correlator === undefined) {
    throw new CrankError("invalid_delivery_mandate", "Incomplete delivery mandate");
  }
  if (expectedCorrelator !== undefined && expectedCorrelator !== correlator) {
    throw new CrankError("invalid_delivery_mandate", "Delivery cursor differs");
  }
  const { parent, group } = groupForRequest(draft, sessionId, parentTaskId, groupId);
  const member = peerMemberOf(group, mandate.address.taskId);
  verifyDeliveryMandate(mandate.deliveryCapability, draft.context.keyring, {
    journalId: draft.context.journalIdentity.id,
    journalIncarnation: draft.context.journalIdentity.incarnation,
    sessionId,
    groupId,
    memberTaskId: member.taskId,
    correlator,
  });
  const memberTask = draft.task(sessionId, member.taskId);
  if (memberTask.lifecycle.status !== "active") {
    throw new CrankError("fork_member_terminal", "Peer member is already terminal");
  }
  const lease = memberTask.execution.liveLease;
  if (
    lease === undefined ||
    lease.ownerId !== mandate.lease.ownerId ||
    lease.epoch !== mandate.lease.epoch ||
    lease.attachmentId !== mandate.attachment.attachmentId ||
    draft.context.nowMs >= lease.expiresAtMs
  ) {
    throw new CrankError("stale_activation", "Delivery mandate lease is stale");
  }
  return { sessionId, parent, group, member, correlator };
}

export function reserveDelegatedPeerSample(
  kernel: AuthorityKernel,
  request: ReserveDelegatedPeerSampleRequest,
): ReserveDelegatedPeerSampleResult {
  const { draft } = kernel;
  if ("audience" in request || request.descriptor.kind !== "sample") {
    throw new CrankError("invalid_descriptor", "Delegated sampling derives its audience locally");
  }
  const { sessionId, member, correlator } = deliveryContext(draft, request.mandate);
  if (member.sampling !== "delegated") {
    throw new CrankError("invalid_descriptor", "Peer member uses private sampling");
  }
  if (member.delegationCorrelator !== correlator) {
    throw new CrankError("invalid_delivery_mandate", "Peer delegation is not committed");
  }
  const task = draft.task(sessionId, member.taskId);
  const result = kernel.reservePull({
    sessionId,
    turnId: task.turnId,
    taskId: task.taskId,
    actionIndex: task.nextActionIndex,
    pullIndex: task.nextPullIndex,
    descriptor: structuredClone(request.descriptor),
    programCapability: draft.programCapability(task),
  });
  if (result.status !== "pending" || result.reason !== "sample") {
    throw new CrankError("invalid_journal", "Delegated sample did not create a sample slot");
  }
  return result;
}

export function commitPeerEvidence(
  kernel: AuthorityKernel,
  request: CommitPeerEvidenceRequest,
): CommitPeerEvidenceResult {
  closePeerMember(kernel, request.mandate, request.correlator, request.outcome);
  return { status: "accepted" };
}

/** Typed peer loss (REQ-043): a journaled `peer_lost` member outcome that
 *  flows through supervision, never a dangling member. */
export function reportPeerLoss(
  kernel: AuthorityKernel,
  request: ReportPeerLossRequest,
): ReportPeerLossResult {
  closePeerMember(kernel, request.mandate, request.correlator, peerLossOutcome(request.reason));
  return { status: "accepted" };
}
