import { CrankError, assertInlineSize, type ProgramStep } from "@sweatpants/durable-execution";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import { canonicalSnapshot, stableTupleHash } from "@sweatpants/foundation";
import type { PullState } from "./authority-contract.ts";
import type { DecisionDraft } from "./decision-draft.ts";
import {
  pullActionIndex,
  pullByAction,
  pullById,
  terminalCancellation,
  type DeepMutable,
  type DraftPull,
  type DraftTask,
} from "./decision-state.ts";
import { forkGroupOutcome, reduceForkMemberTerminal, type ForkGroupState } from "./fork-group.ts";
import { endLiveLease } from "./live-lease.ts";
import { sanitizeCancellationReason } from "./authority-support.ts";
import type {
  CancellationAcknowledgement,
  DurableCancellationState,
  RestoredFrontierProof,
} from "./authority-types.ts";

export function requestCancellation(
  draft: DecisionDraft,
  sessionId: string,
  taskId: string,
  reason?: string,
  commandId = stableTupleHash(["cancel-command", sessionId, taskId]),
): CancellationAcknowledgement {
  const task = draft.task(sessionId, taskId);
  if (task.lifecycle.status !== "active") throw new CrankError("task_terminal");
  const current = task.lifecycle.cancellation;
  if (current.type !== "none")
    return {
      accepted: true,
      duplicate: true,
      commandId: current.commandId,
      ...(current.reason === undefined ? {} : { reason: current.reason }),
      frontier: structuredClone(current.frontier),
    };
  const frontierPull = pullByAction(task, task.nextActionIndex);
  const frontier = {
    actionIndex: task.nextActionIndex,
    ...(frontierPull === undefined ? {} : { pullId: frontierPull.pullId }),
  };
  const safeReason = sanitizeCancellationReason(reason);
  task.lifecycle.cancellation = {
    type: "requested",
    commandId,
    ...(safeReason === undefined ? {} : { reason: safeReason }),
    frontier,
  };
  draft.append(sessionId, undefined, {
    type: "CancellationRequested",
    taskId,
    commandId,
    ...(safeReason === undefined ? {} : { reason: safeReason }),
    frontier,
  });
  draft.session(sessionId).control.runnable = true;
  if (frontierPull && frontierPull.resolution.status === "open") {
    const child =
      frontierPull.request.acceptedDescriptor.kind === "invoke"
        ? [...draft.session(sessionId).execution.tasks.values()].find(
            (candidate) =>
              candidate.origin.kind === "child" &&
              candidate.origin.invokedBy.taskId === taskId &&
              candidate.origin.invokedBy.pullId === frontierPull.pullId &&
              candidate.lifecycle.status === "active",
          )
        : undefined;
    if (child) {
      task.lifecycle.cancellation = {
        type: "cancelling_children",
        commandId,
        childTaskIds: [child.taskId],
        ...(safeReason === undefined ? {} : { reason: safeReason }),
        frontier,
      };
      requestCancellation(
        draft,
        sessionId,
        child.taskId,
        safeReason,
        `${commandId}:child:${child.taskId}`,
      );
    } else {
      const live =
        draft.context.liveEffectTargets?.some(
          (target) => target.taskId === task.taskId && target.pullId === frontierPull.pullId,
        ) ?? false;
      if (live) {
        task.lifecycle.cancellation = {
          type: "settling_pull",
          commandId,
          pullId: frontierPull.pullId,
          ...(safeReason === undefined ? {} : { reason: safeReason }),
          frontier,
        };
      } else {
        cancelNonSettleablePull(draft, sessionId, task, frontierPull);
      }
    }
  }
  return {
    accepted: true,
    duplicate: false,
    commandId,
    ...(safeReason === undefined ? {} : { reason: safeReason }),
    frontier,
  };
}

export function beginCancellationUnwind(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    restoredFrontier?: { proof: RestoredFrontierProof; step: ProgramStep };
  },
): DurableCancellationState {
  const task = draft.task(request.sessionId, request.taskId);
  if (task.lifecycle.status !== "active") return terminalCancellation(task);
  const current = task.lifecycle.cancellation;
  if (current.type === "unwinding") return structuredClone(current);
  if (
    current.type !== "requested" &&
    current.type !== "settling_pull" &&
    current.type !== "cancelling_children"
  )
    throw new CrankError("invalid_command", "Task has no cancellation to unwind");
  const frontierPull = current.frontier.pullId
    ? pullById(task, current.frontier.pullId)
    : undefined;
  if (frontierPull && frontierPull.resolution.status === "open")
    throw new CrankError("cancellation_blocked");
  task.lifecycle.cancellation = {
    type: "unwinding",
    commandId: current.commandId,
    ...(current.reason === undefined ? {} : { reason: current.reason }),
    frontier: current.frontier,
  };
  return structuredClone(task.lifecycle.cancellation);
}

export function detachAttempt(
  draft: DecisionDraft,
  request: { sessionId: string; taskId: string; pullId: string; reason?: string },
): void {
  const task = draft.task(request.sessionId, request.taskId);
  const pull = pullById(task, request.pullId);
  detachPullAttempts(draft, request.sessionId, task, pull, request.reason ?? "transport_lost");
}

export function abandonAttempt(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    pullId: string;
    attemptId: string;
    reason?: string;
  },
): void {
  const task = draft.task(request.sessionId, request.taskId);
  const pull = pullById(task, request.pullId);
  const attempt = pull.attempts.find((candidate) => candidate.attemptId === request.attemptId);
  if (!attempt) throw new CrankError("pull_not_found");
  if (attempt.status === "revoked") return;
  if (attempt.status === "completed" || attempt.status === "superseded")
    throw new CrankError("task_terminal");
  attempt.status = "revoked";
  draft.append(request.sessionId, undefined, {
    type: "AttemptAbandoned",
    taskId: request.taskId,
    pullId: request.pullId,
    attemptId: request.attemptId,
    reason: request.reason ?? "revoked",
  });
}

export function forceOrphan(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged";
  },
): void {
  const task = draft.task(request.sessionId, request.taskId);
  if (task.lifecycle.status === "orphaned") return;
  draft.assertActive(task);
  for (const action of task.actions) {
    if (action.kind !== "pull" || action.pull.resolution.status === "settled") continue;
    action.pull.resolution = {
      ...action.pull.resolution,
      revoked: true,
    } as DraftPull["resolution"];
    for (const attempt of action.pull.attempts) {
      if (attempt.status === "started" || attempt.status === "detached") {
        attempt.status = "revoked";
        draft.append(request.sessionId, undefined, {
          type: "AttemptOutcomeUnknown",
          taskId: request.taskId,
          pullId: action.pull.pullId,
          attemptId: attempt.attemptId,
          reason: "force_orphaned",
        });
      }
    }
  }
  draft.append(request.sessionId, undefined, {
    type: "CleanupSkipped",
    taskId: request.taskId,
    reason: request.reason,
  });
  draft.append(request.sessionId, undefined, {
    type: "TaskOrphaned",
    taskId: request.taskId,
    reason: request.reason,
  });
  task.lifecycle = { status: "orphaned", reason: request.reason };
}

export function settleParentFromChild(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  outcome: OperationOutcome,
): void {
  if (task.origin.kind !== "child") return;
  const parent = draft.task(sessionId, task.origin.invokedBy.taskId);
  const pull = pullById(parent, task.origin.invokedBy.pullId);
  if (!["invoke", "all", "race", "spawn", "join"].includes(pull.request.acceptedDescriptor.kind))
    throw new CrankError("invalid_journal");
  const group = parent.forkGroup;
  if (group !== undefined && group.pullId === pull.pullId) {
    settleForkGroupMember(draft, sessionId, parent, pull, group, task, outcome);
    return;
  }
  settlePullWithOutcome(draft, sessionId, parent, pull, task.execution.epoch, outcome);
}

export function settlePullWithOutcome(
  draft: DecisionDraft,
  sessionId: string,
  parent: DraftTask,
  pull: DraftPull,
  ownerEpoch: number,
  outcome: OperationOutcome,
): void {
  const digest = canonicalSnapshot(outcome).sha;
  if (pull.resolution.status === "settled") {
    if (pull.resolution.settlement.outcomeDigest !== digest)
      throw new CrankError("nondeterminism_detected");
    return;
  }
  const offset = draft.append(sessionId, ownerEpoch, {
    type: "PullResolved",
    taskId: parent.taskId,
    pullId: pull.pullId,
    outcome: structuredClone(outcome),
    outcomeDigest: digest,
  });
  pull.resolution = {
    status: "settled",
    revoked: pull.resolution.revoked,
    settlement: {
      outcome: structuredClone(outcome),
      outcomeDigest: digest,
      receipt: {
        sessionId,
        taskId: parent.taskId,
        pullId: pull.pullId,
        resolutionOffset: offset,
        outcomeDigest: digest,
        status: "accepted",
      },
    },
  };
  parent.nextActionIndex = Math.max(parent.nextActionIndex, pullActionIndex(parent, pull) + 1);
  endLiveLease(draft, sessionId, parent, "settled");
  draft.session(sessionId).control.runnable = true;
}

/**
 * Folds a member terminal into the fork-group algebra (REQ-026). The parent
 * fork slot resolves exactly once, to the closed Terminal value; member
 * biographies cross only inside it. Winner selection, policy-driven member
 * cancellation, and resolution evidence are journal records, in commit
 * order (REQ-032).
 */
function settleForkGroupMember(
  draft: DecisionDraft,
  sessionId: string,
  parent: DraftTask,
  pull: DraftPull,
  group: DeepMutable<ForkGroupState>,
  member: DraftTask,
  outcome: OperationOutcome,
): void {
  const reduction = reduceForkMemberTerminal(group, member.taskId, outcome);
  if (reduction.winnerSelected !== undefined) {
    const lifecycle = member.lifecycle;
    const closeOffset =
      lifecycle.status === "closed" || lifecycle.status === "cancelled"
        ? lifecycle.receipt.offset
        : "0";
    draft.append(sessionId, member.execution.epoch, {
      type: "RaceWinnerSelected",
      taskId: parent.taskId,
      pullId: pull.pullId,
      winnerTaskId: member.taskId,
      closeOffset,
      outcomeDigest: reduction.winnerSelected.outcomeDigest,
    });
  }
  for (const memberTaskId of reduction.cancelMembers) {
    requestCancellation(draft, sessionId, memberTaskId, "fork_group_cancelled");
  }
  if (reduction.resolution !== undefined) {
    const terminal = reduction.resolution;
    draft.append(sessionId, parent.execution.epoch, {
      type: "ForkGroupResolved",
      taskId: parent.taskId,
      pullId: pull.pullId,
      groupId: group.groupId,
      terminal,
      terminalDigest: canonicalSnapshot(terminal).sha,
    });
    settlePullWithOutcome(
      draft,
      sessionId,
      parent,
      pull,
      parent.execution.epoch,
      forkGroupOutcome(terminal),
    );
  }
}

function cancelNonSettleablePull(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
): void {
  pull.resolution = { status: "open", revoked: true };
  let uncertain: string | undefined;
  for (const attempt of pull.attempts) {
    if (attempt.status === "started" || attempt.status === "detached")
      uncertain ??= attempt.attemptId;
    if (attempt.status !== "completed" && attempt.status !== "superseded")
      attempt.status = "revoked";
  }
  if (uncertain)
    draft.append(sessionId, undefined, {
      type: "AttemptOutcomeUnknown",
      taskId: task.taskId,
      pullId: pull.pullId,
      attemptId: uncertain,
      reason: "no_settlement_path",
    });
  settlePull(draft, sessionId, task, pull, { status: "cancelled" });
}
function settlePull(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
  outcome: OperationOutcome,
): void {
  const digest = canonicalSnapshot(outcome).sha;
  const offset = draft.append(sessionId, undefined, {
    type: "PullResolved",
    taskId: task.taskId,
    pullId: pull.pullId,
    outcome,
    outcomeDigest: digest,
  });
  pull.resolution = {
    status: "settled",
    revoked: pull.resolution.revoked,
    settlement: {
      outcome,
      outcomeDigest: digest,
      receipt: {
        sessionId,
        taskId: task.taskId,
        pullId: pull.pullId,
        resolutionOffset: offset,
        outcomeDigest: digest,
        status: "accepted",
      },
    },
  };
  task.nextActionIndex = Math.max(task.nextActionIndex, pullActionIndex(task, pull) + 1);
  endLiveLease(draft, sessionId, task, "settled");
  draft.session(sessionId).control.runnable = true;
}
export function detachTaskAttempts(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  reason: string,
): void {
  for (const action of task.actions)
    if (action.kind === "pull")
      detachPullAttempts(draft, sessionId, task, action.pull as DraftPull, reason);
}
function detachPullAttempts(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
  reason: string,
): void {
  for (const attempt of pull.attempts)
    if (attempt.status === "started") {
      attempt.status = "detached";
      draft.append(sessionId, undefined, {
        type: "AttemptDetached",
        taskId: task.taskId,
        pullId: pull.pullId,
        attemptId: attempt.attemptId,
        reason,
      });
      const descriptor = pull.request.acceptedDescriptor;
      const retrySafety =
        descriptor.kind === "effect"
          ? task.program.manifest.effects[descriptor.name]?.retrySafety
          : descriptor.kind === "record"
            ? descriptor.retrySafety
            : undefined;
      if (
        (descriptor.kind === "effect" || descriptor.kind === "record") &&
        retrySafety?.mode === "unsafe"
      ) {
        draft.append(sessionId, undefined, {
          type: "PullIndeterminate",
          taskId: task.taskId,
          pullId: pull.pullId,
          attemptId: attempt.attemptId,
        });
        failIndeterminate(draft, sessionId, task, pull, attempt, reason);
      }
    }
}
function failIndeterminate(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  pull: DraftPull,
  attempt: DeepMutable<PullState["attempts"][number]>,
  reason: string,
): void {
  attempt.status = "revoked";
  draft.append(sessionId, undefined, {
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
  assertInlineSize(outcome, pull.request.maxOutcomeBytes);
  settlePull(draft, sessionId, task, pull, outcome);
  if (
    task.lifecycle.status === "active" &&
    task.lifecycle.cancellation.type === "settling_pull" &&
    task.lifecycle.cancellation.pullId === pull.pullId
  )
    task.lifecycle.cancellation = {
      type: "requested",
      commandId: task.lifecycle.cancellation.commandId,
      ...(task.lifecycle.cancellation.reason === undefined
        ? {}
        : { reason: task.lifecycle.cancellation.reason }),
      frontier: task.lifecycle.cancellation.frontier,
    };
  draft.session(sessionId).control.runnable = true;
}
