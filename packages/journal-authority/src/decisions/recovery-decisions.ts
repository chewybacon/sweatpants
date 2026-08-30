import {
  CrankError,
  type ProgramStep,
  type ReplayEmissionEntry,
  type ReplayEntry,
  type ReplayOperationEntry,
} from "@sweatpants/durable-execution";
import { canonicalJson, sha256 } from "@sweatpants/foundation";
import type { DecisionDraft } from "./decision-draft.ts";
import type { DraftSession, DraftTask } from "./decision-state.ts";
import type {
  ActivationLeaseState,
  BindRestoreFrontierRequest,
  BindRestoreFrontierResult,
  ConsumeRestoreTicketRequest,
  ConsumeRestoreTicketResult,
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  PrepareProgramRestoreRequest,
  PreparedProgramRestore,
  RestoredFrontierProof,
} from "../contract/authority-types.ts";
import {
  signPrivateAuthorityToken,
  verifyPrivateAuthorityToken,
} from "../contract/capabilities.ts";
import { parseRestoreTicketClaims } from "../state/authority-support.ts";

export function issueRestoreTicket(
  draft: DecisionDraft,
  request: IssueRestoreTicketRequest,
): IssueRestoreTicketResult {
  const session = draft.session(request.sessionId);
  const lease = requireLease(draft, session, request.ownerId, request.activationEpoch);
  draft.task(request.sessionId, request.taskId);
  const restoreNonce = draft.nonce();
  session.control.restoreNonce = restoreNonce;
  session.control.activationLease = { ...lease, restoreNonce };
  const claims = restoreClaims(
    draft,
    request,
    session,
    restoreNonce,
    -1,
    request.replayChainDigest,
  );
  return {
    restoreTicket: signPrivateAuthorityToken("restore-ticket", claims, draft.context.keyring),
    taskRevision: claims.taskRevision,
    journalHeadDigest: claims.journalHeadDigest,
  };
}

export function prepareRestore(
  draft: DecisionDraft,
  request: PrepareProgramRestoreRequest,
): PreparedProgramRestore {
  const session = draft.session(request.sessionId);
  const lease = requireLease(draft, session, request.ownerId, request.activationEpoch);
  const task = draft.task(request.sessionId, request.taskId);
  if (task.execution.epoch !== request.activationEpoch) throw new CrankError("stale_activation");
  const restoreNonce = draft.nonce();
  const replayChainSeed = sha256(
    canonicalJson({
      domain: request.replayDomain,
      protocolVersion: 1,
      releaseId: request.releaseId,
      sessionId: request.sandboxSessionId,
      taskId: request.taskId,
      program: task.program.artifact,
      activationEpoch: request.activationEpoch,
      journalHeadDigest: draft.context.journalHeadDigest,
      restoreNonce,
    }),
  );
  const replay: ReplayEntry[] = [];
  let previousEntryDigest = replayChainSeed;
  let replayedThroughActionIndex = -1;
  for (let actionIndex = 0; actionIndex < task.nextActionIndex; actionIndex += 1) {
    const action = task.actions.find((candidate) => candidate.actionIndex === actionIndex);
    if (!action) throw new CrankError("invalid_journal", "Replay history has an action gap");
    let body: Omit<ReplayOperationEntry, "entryDigest"> | Omit<ReplayEmissionEntry, "entryDigest">;
    if (action.kind === "pull" && action.pull.resolution.status === "settled")
      body = {
        type: "operation",
        actionIndex,
        descriptorKind: action.pull.request.proposedDescriptor.kind,
        descriptorDigest: action.pull.request.proposedDescriptorDigest,
        previousEntryDigest,
        outcome: structuredClone(action.pull.resolution.settlement.outcome),
        receipt: structuredClone(action.pull.resolution.settlement.receipt),
      };
    else if (action.kind === "emission")
      body = {
        type: "emission",
        actionIndex,
        descriptorKind: "emission",
        descriptorDigest: action.descriptorDigest,
        previousEntryDigest,
        offset: action.receipt.offset,
      };
    else throw new CrankError("invalid_journal", "Replay history has an action gap");
    const entryDigest = sha256(
      canonicalJson({ replayChainSeed, previousEntryDigest, entryWithoutEntryDigest: body }),
    );
    replay.push({ ...body, entryDigest } as ReplayEntry);
    previousEntryDigest = entryDigest;
    replayedThroughActionIndex = actionIndex;
  }
  session.control.restoreNonce = restoreNonce;
  Reflect.deleteProperty(session.control, "restoreFrontierDigest");
  session.control.activationLease = { ...lease, restoreNonce };
  const claims = restoreClaims(
    draft,
    request,
    session,
    restoreNonce,
    replayedThroughActionIndex,
    previousEntryDigest,
  );
  return {
    restoreTicket: signPrivateAuthorityToken("restore-ticket", claims, draft.context.keyring),
    replay,
    replayedThroughActionIndex,
    replayChainSeed,
    replayChainDigest: previousEntryDigest,
    taskRevision: claims.taskRevision,
    journalHeadDigest: claims.journalHeadDigest,
  };
}

export function bindFrontier(
  draft: DecisionDraft,
  request: BindRestoreFrontierRequest,
): BindRestoreFrontierResult {
  let claims;
  try {
    claims = parseRestoreTicketClaims(
      verifyPrivateAuthorityToken(request.restoreTicket, "restore-ticket", draft.context.keyring),
    );
  } catch {
    return { status: "restore_stale" };
  }
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  if (
    !/^[0-9a-f]{64}$/.test(request.frontierDigest) ||
    !lease ||
    draft.context.nowMs >= lease.expiresAtMs ||
    lease.ownerId !== request.ownerId ||
    lease.epoch !== request.activationEpoch ||
    claims.sessionId !== request.sessionId ||
    claims.taskId !== request.taskId ||
    claims.ownerId !== request.ownerId ||
    claims.activationEpoch !== request.activationEpoch ||
    claims.taskRevision !== session.control.revision ||
    claims.journalHeadDigest !== draft.context.journalHeadDigest ||
    claims.restoreNonce !== session.control.restoreNonce
  )
    return { status: "restore_stale" };
  session.control.restoreFrontierDigest = request.frontierDigest;
  return {
    status: "bound",
    proof: { restoreTicket: request.restoreTicket, frontierDigest: request.frontierDigest },
  };
}

export function consumeTicket(
  draft: DecisionDraft,
  request: ConsumeRestoreTicketRequest,
): ConsumeRestoreTicketResult {
  let claims;
  try {
    claims = parseRestoreTicketClaims(
      verifyPrivateAuthorityToken(
        request.proof.restoreTicket,
        "restore-ticket",
        draft.context.keyring,
      ),
    );
  } catch {
    return recordRestoreStale(draft, request.sessionId);
  }
  const session = draft.session(request.sessionId);
  const lease = session.control.activationLease;
  const valid =
    /^[0-9a-f]{64}$/.test(request.proof.frontierDigest) &&
    claims.journalId === draft.context.journalIdentity.id &&
    claims.journalIncarnation === draft.context.journalIdentity.incarnation &&
    claims.sessionId === request.sessionId &&
    claims.taskId === request.taskId &&
    claims.ownerId === request.ownerId &&
    claims.activationEpoch === request.activationEpoch &&
    lease?.ownerId === request.ownerId &&
    lease.epoch === request.activationEpoch &&
    draft.context.nowMs < lease.expiresAtMs &&
    claims.taskRevision === session.control.revision &&
    claims.journalHeadDigest === draft.context.journalHeadDigest &&
    claims.restoreNonce === session.control.restoreNonce &&
    request.proof.frontierDigest === session.control.restoreFrontierDigest;
  if (!valid) return recordRestoreStale(draft, request.sessionId);
  const nonce = draft.nonce();
  session.control.restoreNonce = nonce;
  Reflect.deleteProperty(session.control, "restoreFrontierDigest");
  session.control.activationLease = { ...lease!, restoreNonce: nonce };
  session.control.consecutiveRestoreStales = 0;
  Reflect.deleteProperty(session.control, "activationNotBeforeMs");
  return { status: "consumed" };
}

export function consumeRestoredFrontier(
  draft: DecisionDraft,
  sessionId: string,
  task: DraftTask,
  proof: RestoredFrontierProof,
  step: ProgramStep | undefined,
): void {
  const session = draft.session(sessionId);
  const lease = session.control.activationLease;
  if (!lease || step === undefined) throw new CrankError("restore_stale");
  let claims;
  try {
    claims = parseRestoreTicketClaims(
      verifyPrivateAuthorityToken(proof.restoreTicket, "restore-ticket", draft.context.keyring),
    );
  } catch {
    throw new CrankError("restore_stale");
  }
  if (!claims.releaseId || !claims.frontierDomain) throw new CrankError("restore_stale");
  const expected = sha256(
    canonicalJson({
      domain: claims.frontierDomain,
      protocolVersion: 1,
      releaseId: claims.releaseId,
      taskId: task.taskId,
      activationEpoch: task.execution.epoch,
      replayedThroughActionIndex: claims.replayedThroughActionIndex,
      replayChainDigest: claims.replayChainDigest,
      step,
    }),
  );
  if (proof.frontierDigest !== expected) throw new CrankError("restore_stale");
  const result = consumeTicket(draft, {
    sessionId,
    taskId: task.taskId,
    ownerId: lease.ownerId,
    activationEpoch: task.execution.epoch,
    proof,
  });
  if (result.status === "restore_stale") throw new CrankError("restore_stale");
}

function requireLease(
  draft: DecisionDraft,
  session: DraftSession,
  ownerId: string,
  epoch: number,
): ActivationLeaseState {
  const lease = session.control.activationLease;
  if (
    !lease ||
    lease.ownerId !== ownerId ||
    lease.epoch !== epoch ||
    draft.context.nowMs >= lease.expiresAtMs
  )
    throw new CrankError("stale_activation");
  return lease;
}
function restoreClaims(
  draft: DecisionDraft,
  request: {
    sessionId: string;
    taskId: string;
    ownerId: string;
    activationEpoch: number;
    releaseId?: string;
    sandboxSessionId?: string;
    replayDomain?: string;
    frontierDomain?: string;
    replayedThroughActionIndex?: number;
    replayChainDigest?: string;
  },
  session: DraftSession,
  restoreNonce: string,
  replayedThroughActionIndex: number,
  replayChainDigest: string,
) {
  return {
    version: 1 as const,
    journalId: draft.context.journalIdentity.id,
    journalIncarnation: draft.context.journalIdentity.incarnation,
    sessionId: request.sessionId,
    taskId: request.taskId,
    ownerId: request.ownerId,
    activationEpoch: request.activationEpoch,
    ...(request.releaseId === undefined ? {} : { releaseId: request.releaseId }),
    ...(request.sandboxSessionId === undefined
      ? {}
      : { sandboxSessionId: request.sandboxSessionId }),
    ...(request.replayDomain === undefined ? {} : { replayDomain: request.replayDomain }),
    ...(request.frontierDomain === undefined ? {} : { frontierDomain: request.frontierDomain }),
    taskRevision: session.control.revision,
    journalHeadDigest: draft.context.journalHeadDigest,
    replayedThroughActionIndex,
    replayChainDigest,
    restoreNonce,
  };
}
function recordRestoreStale(
  draft: DecisionDraft,
  sessionId: string,
): Extract<ConsumeRestoreTicketResult, { status: "restore_stale" }> {
  const session = draft.session(sessionId);
  Reflect.deleteProperty(session.control, "restoreFrontierDigest");
  const count = session.control.consecutiveRestoreStales + 1;
  session.control.consecutiveRestoreStales = count;
  if (count < 3)
    return {
      status: "restore_stale",
      consecutiveStales: count,
      retryAfterMs: 0,
      releaseRequired: false,
    };
  const retryAfterMs = Math.min(250 * 2 ** (count - 3), 5_000);
  session.control.activationNotBeforeMs = draft.context.nowMs + retryAfterMs;
  delete session.control.activationLease;
  session.control.runnable = true;
  return { status: "restore_stale", consecutiveStales: count, retryAfterMs, releaseRequired: true };
}
