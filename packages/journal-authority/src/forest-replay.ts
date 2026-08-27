import {
  CrankError,
  type ForestReplayPlan,
  type ForkContext,
  type PeerReadyTarget,
  type PlannedForestRow,
  type ReplayEmissionEntry,
  type ReplayEntry,
  type ReplayItem,
  type ReplayOperationEntry,
  type StrandHead,
} from "@sweatpants/durable-execution";
import { canonicalJson, sha256 } from "@sweatpants/foundation";

import type {
  AuthoritySessionState,
  AuthorityState,
  PullState,
  TaskState,
} from "./authority-contract.ts";

const REPLAY_DOMAIN = "sweatpants.forest-replay.v1";

/**
 * Pure breadth-first forest planner (REQ-007..REQ-011).
 *
 * It reads one immutable Authority state plus its journal-head digest, classifies
 * every row before producing work, and returns no command surface, lease, venue,
 * capability, or selection. Rows are parent-before-child and every row appears
 * in exactly one class.
 */
export function planForestReplay(
  state: AuthorityState,
  sessionId: string,
  journalHeadDigest: string,
  nowMs = 0,
): ForestReplayPlan {
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    throw new CrankError("unknown_target", `Unknown session ${sessionId}`);
  }
  const ordered = breadthFirstTasks(session);
  const rows: PlannedForestRow[] = [];
  const replay: ReplayItem[] = [];
  const peers: PeerReadyTarget[] = [];

  for (const task of ordered) {
    const groupContext = forkContext(session, task);
    const head = strandHead(task);
    const durability = taskDurability(session, task);
    const classification = classifyTask(session, task, durability, nowMs);
    const parked = parkedHead(task);
    const row: PlannedForestRow = {
      address: { sessionId, turnId: task.turnId, taskId: task.taskId },
      strand: task.taskId,
      head,
      program: structuredClone(task.program.artifact),
      classification,
      ...(parked === undefined
        ? {}
        : {
            parked: {
              pullId: parked.pullId,
              reason: parkedReason(parked),
              audience: parked.resolutionAuthority.audience,
            },
          }),
      groupContext,
    };
    rows.push(row);

    if (classification === "replayable") {
      replay.push(buildReplayItem(task, row, journalHeadDigest));
    } else if (classification === "peer_hosted") {
      const member = memberState(session, task.taskId);
      if (!peerInvariantHolds(task, member)) continue;
      peers.push({
        address: row.address,
        strand: row.strand,
        evidenceHead: head,
        executionEpoch: task.execution.epoch,
        groupContext,
        frontierProof: {
          strandHeadDigest: head.digest,
          groupRevision: groupContext.groupRevision,
        },
        deliveryCursor: {
          ...(member?.delegationCorrelator === undefined
            ? {}
            : { correlator: member.delegationCorrelator }),
        },
      });
    }
  }

  return {
    sessionId,
    forestRevision: session.control.revision,
    journalHeadDigest,
    rows,
    replay,
    peers,
  };
}

/** Deterministic strand digest used by plan/bind CAS. */
export function strandHead(task: TaskState): StrandHead {
  const durablePrefix = task.actions.slice(0, task.nextActionIndex).map((action) =>
    action.kind === "pull"
      ? {
          kind: "pull" as const,
          actionIndex: action.actionIndex,
          pullIndex: action.pullIndex,
          descriptorDigest: action.pull.request.proposedDescriptorDigest,
          resolution:
            action.pull.resolution.status === "settled"
              ? {
                  status: "settled" as const,
                  offset: action.pull.resolution.settlement.receipt.resolutionOffset,
                  outcomeDigest: action.pull.resolution.settlement.outcomeDigest,
                }
              : { status: "open" as const },
        }
      : {
          kind: "emission" as const,
          actionIndex: action.actionIndex,
          emissionIndex: action.emissionIndex,
          descriptorDigest: action.descriptorDigest,
          offset: action.receipt.offset,
        },
  );
  return {
    actionIndex: task.nextActionIndex - 1,
    digest: sha256(
      canonicalJson({
        domain: "sweatpants.strand-head.v1",
        taskId: task.taskId,
        program: task.program.artifact,
        prefix: durablePrefix,
        lifecycle: task.lifecycle.status,
      }),
    ),
  };
}

function breadthFirstTasks(session: AuthoritySessionState): TaskState[] {
  const children = new Map<string, TaskState[]>();
  const roots: TaskState[] = [];
  for (const task of session.execution.tasks.values()) {
    if (task.origin.kind === "root") {
      roots.push(task);
    } else {
      const siblings = children.get(task.origin.invokedBy.taskId) ?? [];
      siblings.push(task);
      children.set(task.origin.invokedBy.taskId, siblings);
    }
  }
  const compare = (left: TaskState, right: TaskState) => left.taskId.localeCompare(right.taskId);
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);

  const result: TaskState[] = [];
  const queue = [...roots];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const task = queue.shift()!;
    if (seen.has(task.taskId)) throw new CrankError("invalid_journal", "Forest contains a cycle");
    seen.add(task.taskId);
    result.push(task);
    queue.push(...(children.get(task.taskId) ?? []));
  }
  if (result.length !== session.execution.tasks.size) {
    throw new CrankError("invalid_journal", "Forest contains an unreachable row");
  }
  return result;
}

function classifyTask(
  session: AuthoritySessionState,
  task: TaskState,
  durability: "crank_native" | "peer_hosted",
  nowMs: number,
): PlannedForestRow["classification"] {
  if (task.lifecycle.status !== "active") return "terminal";
  if (task.execution.liveLease !== undefined && task.execution.liveLease.expiresAtMs > nowMs) {
    return "structurally_blocked";
  }
  if (durability === "peer_hosted") return "peer_hosted";
  if (task.forkGroup !== undefined && task.forkGroup.status !== "resolved") {
    return "structurally_blocked";
  }
  const frontier = task.actions[task.nextActionIndex];
  if (frontier?.kind === "pull" && frontier.pull.resolution.status === "open") {
    return "structurally_blocked";
  }
  // A parent with an active child is structurally blocked even if a damaged
  // materialized cursor omitted the expected open invoke slot.
  for (const candidate of session.execution.tasks.values()) {
    if (
      candidate.origin.kind === "child" &&
      candidate.origin.invokedBy.taskId === task.taskId &&
      candidate.lifecycle.status === "active"
    ) {
      return "structurally_blocked";
    }
  }
  return "replayable";
}

function peerInvariantHolds(task: TaskState, member: ReturnType<typeof memberState>): boolean {
  if (
    task.lifecycle.status !== "active" ||
    task.lifecycle.cancellation.type !== "none" ||
    member?.durability !== "peer_hosted"
  ) {
    return false;
  }
  return !task.actions.some((action) => {
    if (action.kind !== "pull") return false;
    if (action.pull.attempts.some((attempt) => attempt.status === "started")) return true;
    if (action.pull.resolution.status === "settled") return false;
    return !(
      member.sampling === "delegated" &&
      member.delegationCorrelator !== undefined &&
      action.pull.request.acceptedDescriptor.kind === "sample"
    );
  });
}

function taskDurability(
  session: AuthoritySessionState,
  task: TaskState,
): "crank_native" | "peer_hosted" {
  return memberState(session, task.taskId)?.durability === "peer_hosted"
    ? "peer_hosted"
    : "crank_native";
}

function memberState(session: AuthoritySessionState, taskId: string) {
  for (const parent of session.execution.tasks.values()) {
    const member = parent.forkGroup?.members.find((candidate) => candidate.taskId === taskId);
    if (member !== undefined) return member;
  }
  return undefined;
}

function forkContext(session: AuthoritySessionState, task: TaskState): ForkContext {
  if (task.forkGroup !== undefined) {
    return {
      groupId: task.forkGroup.groupId,
      groupRevision: task.forkGroup.revision ?? 0,
      parentTaskId: task.taskId,
    };
  }
  for (const parent of session.execution.tasks.values()) {
    if (parent.forkGroup?.members.some((member) => member.taskId === task.taskId)) {
      return {
        groupId: parent.forkGroup.groupId,
        groupRevision: parent.forkGroup.revision ?? 0,
        parentTaskId: parent.taskId,
      };
    }
  }
  return { groupRevision: 0 };
}

function buildReplayItem(
  task: TaskState,
  row: PlannedForestRow,
  journalHeadDigest: string,
): ReplayItem {
  const replayChainSeed = sha256(
    canonicalJson({
      domain: REPLAY_DOMAIN,
      journalHeadDigest,
      address: row.address,
      strand: row.strand,
      plannedHead: row.head,
      program: row.program,
    }),
  );
  const replay: ReplayEntry[] = [];
  let previousEntryDigest = replayChainSeed;
  let replayedThroughActionIndex = -1;
  for (let actionIndex = 0; actionIndex < task.nextActionIndex; actionIndex += 1) {
    const action = task.actions[actionIndex];
    if (action === undefined || action.actionIndex !== actionIndex) {
      throw new CrankError("invalid_journal", "Replay history has an action gap");
    }
    let body: Omit<ReplayOperationEntry, "entryDigest"> | Omit<ReplayEmissionEntry, "entryDigest">;
    if (action.kind === "pull" && action.pull.resolution.status === "settled") {
      body = {
        type: "operation",
        actionIndex,
        descriptorKind: action.pull.request.proposedDescriptor.kind,
        descriptorDigest: action.pull.request.proposedDescriptorDigest,
        previousEntryDigest,
        outcome: structuredClone(action.pull.resolution.settlement.outcome),
        receipt: structuredClone(action.pull.resolution.settlement.receipt),
      };
    } else if (action.kind === "emission") {
      body = {
        type: "emission",
        actionIndex,
        descriptorKind: "emission",
        descriptorDigest: action.descriptorDigest,
        previousEntryDigest,
        offset: action.receipt.offset,
      };
    } else {
      throw new CrankError("invalid_journal", "Replay prefix contains an unresolved slot");
    }
    const entryDigest = sha256(
      canonicalJson({ replayChainSeed, previousEntryDigest, entryWithoutEntryDigest: body }),
    );
    replay.push({ ...body, entryDigest } as ReplayEntry);
    previousEntryDigest = entryDigest;
    replayedThroughActionIndex = actionIndex;
  }
  return {
    address: row.address,
    strand: row.strand,
    plannedHead: row.head,
    program: row.program,
    input: structuredClone(task.program.input),
    route: structuredClone(task.execution.route ?? { driverKind: "program" }),
    executionEpoch: task.execution.epoch,
    groupContext: row.groupContext,
    replay,
    replayedThroughActionIndex,
    replayChainSeed,
    replayChainDigest: previousEntryDigest,
  };
}

/** Used by bind CAS to compare the current materialized row with a plan. */
export function currentForkGroupRevision(session: AuthoritySessionState, taskId: string): number {
  const task = session.execution.tasks.get(taskId);
  if (task === undefined) throw new CrankError("unknown_target", `Unknown task ${taskId}`);
  return forkContext(session, task).groupRevision;
}

/** Invariant W predicate exported for focused property tests. */
export function replayPrefixIsClosed(task: TaskState): boolean {
  for (let index = 0; index < task.nextActionIndex; index += 1) {
    const action = task.actions[index];
    if (action === undefined) return false;
    if (action.kind === "pull" && action.pull.resolution.status !== "settled") return false;
  }
  return true;
}

function parkedReason(pull: PullState): string {
  switch (pull.request.acceptedDescriptor.kind) {
    case "elicit":
    case "wait":
    case "sample":
      return pull.request.acceptedDescriptor.kind;
    case "ephemeral":
    case "foreign":
      return "ephemeral";
    case "invoke":
    case "all":
    case "race":
    case "spawn":
    case "join":
      return "child";
    case "effect":
    case "record":
      return "external_effect";
  }
}

/** The unresolved participant-addressable head, if this row is parked. */
export function parkedHead(task: TaskState): PullState | undefined {
  const action = task.actions[task.nextActionIndex];
  return action?.kind === "pull" && action.pull.resolution.status === "open"
    ? action.pull
    : undefined;
}
