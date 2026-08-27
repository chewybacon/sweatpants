import {
  CrankError,
  type DurableAllDescriptor,
  type DurableChildDescriptor,
  type DurableRaceDescriptor,
} from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import { canonicalSnapshot, stableTupleHash } from "@sweatpants/foundation";
import type { DecisionDraft } from "./decision-draft.ts";
import type { DeepMutable, DraftPull, DraftTask } from "./decision-state.ts";
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
} from "./fork-group.ts";
import { signCapability, verifyDeliveryMandate } from "./capabilities.ts";
import type {
  BreachForkGroupRequest,
  BreachForkGroupResult,
  CancellationAcknowledgement,
  CommitPeerDelegationRequest,
  CommitPeerDelegationResult,
  CommitPeerEvidenceRequest,
  CommitPeerEvidenceResult,
  ForceOrphanForkGroupRequest,
  ForceOrphanForkGroupResult,
  OpenDurableTaskRequest,
  OpenForkGroupRequest,
  OpenForkGroupResult,
  ReportPeerLossRequest,
  ReportPeerLossResult,
} from "./authority-types.ts";

export interface ForkDecisionServices {
  openTask(draft: DecisionDraft, request: OpenDurableTaskRequest): { programCapability: string };
  requestCancellation(
    draft: DecisionDraft,
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): CancellationAcknowledgement;
  settlePull(
    draft: DecisionDraft,
    sessionId: string,
    parent: DraftTask,
    pull: DraftPull,
    ownerEpoch: number,
    outcome: OperationOutcome,
  ): void;
  settleParent(
    draft: DecisionDraft,
    sessionId: string,
    task: DraftTask,
    outcome: OperationOutcome,
  ): void;
}

type ForkDescriptorPayload =
  | (DurableAllDescriptor & { readonly children: readonly DurableChildDescriptor[] })
  | (DurableRaceDescriptor & { readonly children: readonly DurableChildDescriptor[] });

/**
 * Atomic fork-group admission (REQ-021/023/030). Opens the group row and
 * every member row in one commit; identical retries return the recorded
 * opening; a second distinct group on a nonterminal pull is refused.
 */
export function openForkGroup(
  draft: DecisionDraft,
  request: OpenForkGroupRequest,
  services: ForkDecisionServices,
): OpenForkGroupResult {
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
      canonicalSnapshot(expected.input).sha !== canonicalSnapshot(member.child.input).sha
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
    services.openTask(draft, {
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
  draft: DecisionDraft,
  request: BreachForkGroupRequest,
  services: ForkDecisionServices,
): BreachForkGroupResult {
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
      services.requestCancellation(draft, request.sessionId, memberTaskId, "fork_group_expired");
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
      terminalDigest: canonicalSnapshot(resolution).sha,
    });
    services.settlePull(
      draft,
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
  draft: DecisionDraft,
  request: ForceOrphanForkGroupRequest,
  services: ForkDecisionServices,
): ForceOrphanForkGroupResult {
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
    terminalDigest: canonicalSnapshot(resolution).sha,
  });
  services.settlePull(
    draft,
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

function mintDeliveryMandate(
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
  const { parent, group } = groupForRequest(
    draft,
    request.sessionId,
    request.taskId,
    request.groupId,
  );
  if (group.status === "resolved") {
    throw new CrankError("fork_group_terminal", "Fork group already resolved");
  }
  const member = peerMemberOf(group, request.memberTaskId);
  const correlator = peerDeliveryCorrelator(group.groupId, member.taskId);
  const mandate = mintDeliveryMandate(
    draft,
    request.sessionId,
    parent,
    group,
    member.taskId,
    correlator,
    member.peer!,
  );
  if (member.delegationCorrelator !== undefined) {
    if (member.delegationCorrelator !== correlator) {
      throw new CrankError("nondeterminism_detected", "Peer delegation correlator differs");
    }
    return { status: "duplicate", correlator, deliveryMandate: mandate };
  }
  member.delegationCorrelator = correlator;
  group.revision = (group.revision ?? 0) + 1;
  draft.append(request.sessionId, parent.execution.epoch, {
    type: "PeerDelegationCommitted",
    taskId: parent.taskId,
    groupId: group.groupId,
    memberTaskId: member.taskId,
    correlator,
    peer: member.peer!,
    deadlineMs: group.deadlineMs,
  });
  draft.session(request.sessionId).control.runnable = true;
  return { status: "committed", correlator, deliveryMandate: mandate };
}

/**
 * Closes a peer member from external evidence. Invariant P (REQ-075): the
 * member row holds a structural task and evidence only — no local attempt
 * ever exists on it, and the evidence commits through the ordinary group
 * reducer so supervision stays exact (REQ-043).
 */
function closePeerMember(
  draft: DecisionDraft,
  sessionId: string,
  group: DeepMutable<ForkGroupState>,
  memberTaskId: string,
  correlator: string,
  mandate: string,
  outcome: OperationOutcome,
  services: ForkDecisionServices,
): void {
  const member = peerMemberOf(group, memberTaskId);
  verifyDeliveryMandate(mandate, draft.context.keyring, {
    journalId: draft.context.journalIdentity.id,
    journalIncarnation: draft.context.journalIdentity.incarnation,
    sessionId,
    groupId: group.groupId,
    memberTaskId,
    correlator,
  });
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
  services.settleParent(draft, sessionId, memberTask, outcome);
}

export function commitPeerEvidence(
  draft: DecisionDraft,
  request: CommitPeerEvidenceRequest,
  services: ForkDecisionServices,
): CommitPeerEvidenceResult {
  const { group } = groupForRequest(draft, request.sessionId, request.taskId, request.groupId);
  closePeerMember(
    draft,
    request.sessionId,
    group,
    request.memberTaskId,
    request.correlator,
    request.deliveryMandate,
    request.outcome,
    services,
  );
  return { status: "accepted" };
}

/** Typed peer loss (REQ-043): a journaled `peer_lost` member outcome that
 *  flows through supervision, never a dangling member. */
export function reportPeerLoss(
  draft: DecisionDraft,
  request: ReportPeerLossRequest,
  services: ForkDecisionServices,
): ReportPeerLossResult {
  const { group } = groupForRequest(draft, request.sessionId, request.taskId, request.groupId);
  closePeerMember(
    draft,
    request.sessionId,
    group,
    request.memberTaskId,
    request.correlator,
    request.deliveryMandate,
    peerLossOutcome(request.reason),
    services,
  );
  return { status: "accepted" };
}
