import type { OperationOutcome } from "@sweatpants/durable-effects";
import type { DecisionDraft } from "./decision-draft.ts";
import {
  detachTaskAttempts,
  requestCancellation as requestCancellationDecision,
  settleParentFromChild,
  settlePullWithOutcome,
} from "./execution-lifecycle-decisions.ts";
import { reservePull } from "./pull-decisions.ts";
import type {
  CancellationAcknowledgement,
  OpenDurableTaskRequest,
  ReserveOperationRequest,
  ReserveOperationResult,
} from "./authority-types.ts";
import { openTask } from "./task-decisions.ts";
import type { DraftPull, DraftTask } from "./decision-state.ts";

/**
 * Cross-domain transitions available inside one authority transaction.
 *
 * The draft is bound once at the transaction boundary; domain decisions only
 * receive this context when they need to cross into another decision family.
 */
export interface AuthorityKernel {
  readonly draft: DecisionDraft;
  openTask(request: OpenDurableTaskRequest): { readonly programCapability: string };
  requestCancellation(
    sessionId: string,
    taskId: string,
    reason?: string,
    commandId?: string,
  ): CancellationAcknowledgement;
  settlePull(
    sessionId: string,
    parent: DraftTask,
    pull: DraftPull,
    ownerEpoch: number,
    outcome: OperationOutcome,
  ): void;
  settleParent(sessionId: string, task: DraftTask, outcome: OperationOutcome): void;
  reservePull(request: ReserveOperationRequest): ReserveOperationResult;
  detachAttempts(sessionId: string, task: DraftTask, reason: string): void;
}

export function createAuthorityKernel(draft: DecisionDraft): AuthorityKernel {
  return {
    draft,
    openTask: (request) => openTask(draft, request),
    requestCancellation: (sessionId, taskId, reason, commandId) =>
      requestCancellationDecision(draft, sessionId, taskId, reason, commandId),
    settlePull: (sessionId, parent, pull, ownerEpoch, outcome) =>
      settlePullWithOutcome(draft, sessionId, parent, pull, ownerEpoch, outcome),
    settleParent: (sessionId, task, outcome) =>
      settleParentFromChild(draft, sessionId, task, outcome),
    reservePull: (request) => reservePull(draft, request),
    detachAttempts: (sessionId, task, reason) => detachTaskAttempts(draft, sessionId, task, reason),
  };
}
