import { CrankError } from "@sweatpants/durable-execution";
import type {
  ClaimActivationRequest,
  ClaimActivationResult,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  RenewActivationRequest,
  RenewActivationResult,
} from "../contract/authority-types.ts";
import type { DecisionDraft } from "./decision-draft.ts";

export function claimActivation(
  draft: DecisionDraft,
  request: ClaimActivationRequest,
): ClaimActivationResult {
  if (!request.sessionId || !request.ownerId) {
    throw new CrankError("invalid_command");
  }
  const duration = request.leaseDurationMs ?? 30_000;
  if (!Number.isInteger(duration) || duration < 1_000 || duration > 300_000) {
    throw new CrankError("invalid_command");
  }
  const currentSession = draft.readSession(request.sessionId);
  const now = draft.context.nowMs;
  const notBefore = currentSession.control.activationNotBeforeMs ?? 0;
  if (now < notBefore) {
    return { status: "busy", retryAfterMs: notBefore - now };
  }
  const current = currentSession.control.activationLease;
  if (current && now < current.expiresAtMs) {
    return { status: "busy", retryAfterMs: current.expiresAtMs - now };
  }
  const expiredTakeover = current !== undefined;
  if (!currentSession.control.runnable && !expiredTakeover) {
    return { status: "not_runnable" };
  }
  const session = draft.session(request.sessionId);
  const epoch = currentSession.control.lastActivationEpoch + 1;
  session.control.lastActivationEpoch = epoch;
  for (const task of session.execution.tasks.values()) {
    if (task.lifecycle.status === "active") {
      draft.task(request.sessionId, task.taskId).execution.epoch = epoch;
    }
  }
  const restoreNonce = draft.nonce();
  session.control.restoreNonce = restoreNonce;
  const lease = {
    sessionId: request.sessionId,
    ownerId: request.ownerId,
    epoch,
    expiresAtMs: now + duration,
    leaseDurationMs: duration,
    claimedTaskRevision: currentSession.control.revision,
    claimedHeadId: draft.context.journalHeadId,
    restoreNonce,
  };
  session.control.activationLease = lease;
  session.control.runnable = false;
  return {
    status: "claimed",
    epoch,
    expiresAtMs: lease.expiresAtMs,
    taskRevision: currentSession.control.revision,
    journalHeadId: draft.context.journalHeadId,
  };
}

export function renewActivation(
  draft: DecisionDraft,
  request: RenewActivationRequest,
): RenewActivationResult {
  const lease = draft.readSession(request.sessionId).control.activationLease;
  if (
    lease === undefined ||
    lease.ownerId !== request.ownerId ||
    lease.epoch !== request.epoch ||
    draft.context.nowMs >= lease.expiresAtMs
  ) {
    return { status: "stale_activation" };
  }
  const expiresAtMs = draft.context.nowMs + lease.leaseDurationMs;
  if (expiresAtMs !== lease.expiresAtMs) {
    draft.session(request.sessionId).control.activationLease = { ...lease, expiresAtMs };
  }
  return { status: "renewed", expiresAtMs };
}

export function releaseActivation(
  draft: DecisionDraft,
  request: ReleaseActivationRequest,
): ReleaseActivationResult {
  const lease = draft.readSession(request.sessionId).control.activationLease;
  if (lease === undefined || lease.ownerId !== request.ownerId || lease.epoch !== request.epoch) {
    return { status: "stale_activation" };
  }
  const session = draft.session(request.sessionId);
  delete session.control.activationLease;
  const retryable = ["failed", "scope_exit", "lease_lost"].includes(request.reason);
  const runnable = request.reason !== "terminal" && (retryable || session.control.runnable);
  session.control.runnable = runnable;
  return { status: "released", runnable };
}
