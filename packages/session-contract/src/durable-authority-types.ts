/**
 * Journal authority declarations.
 *
 * The operations a journal authority exposes and the request/result pairs that
 * carry them: activation leases, restore tickets, reserve/resolve, cancellation
 * and completion. Depends on the contract and protocol layers.
 */

import type { Operation } from "effection";
import type { Json } from "./types.ts";
import type {
  DurableChildDescriptor,
  DurableOperationDescriptor,
  DurableProgramManifest,
  EffectDefinition,
  EffectDescriptor,
  EmissionDescriptor,
  OperationOutcome,
  RecordedOperationDescriptor,
} from "./durable-contract-types.ts";
import type {
  ProgramRoute,
  ProgramStep,
  ReplayEntry,
  ResolutionReceipt,
} from "./durable-protocol-types.ts";

/** Private, authority-time activation ownership state. */
export interface ActivationLeaseState {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly expiresAtMs: number;
  readonly leaseDurationMs: number;
  readonly claimedTaskRevision: number;
  readonly claimedHeadDigest: string;
  readonly restoreNonce: string;
}

export interface ClaimActivationRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly leaseDurationMs?: number;
}

export type ClaimActivationResult =
  | {
      readonly status: "claimed";
      readonly epoch: number;
      readonly expiresAtMs: number;
      readonly taskRevision: number;
      readonly journalHeadDigest: string;
    }
  | { readonly status: "busy"; readonly retryAfterMs: number }
  | { readonly status: "not_runnable" };

export interface RenewActivationRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly epoch: number;
}

export type RenewActivationResult =
  | { readonly status: "renewed"; readonly expiresAtMs: number }
  | { readonly status: "stale_activation" };

export interface ReleaseActivationRequest {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly reason: "parked" | "terminal" | "failed" | "scope_exit" | "lease_lost";
}

export type ReleaseActivationResult =
  | { readonly status: "released"; readonly runnable: boolean }
  | { readonly status: "stale_activation" };

export interface RecoverableSession {
  readonly sessionId: string;
  readonly reason: "runnable" | "expired_activation";
  readonly notBeforeMs?: number;
}

/** Host-private claims authenticated by the authority for one restored frontier. */
export interface RestoreTicketClaims {
  readonly version: 1;
  readonly journalId: string;
  readonly journalIncarnation: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly activationEpoch: number;
  readonly releaseId?: string;
  readonly sandboxSessionId?: string;
  readonly replayDomain?: string;
  readonly frontierDomain?: string;
  readonly taskRevision: number;
  readonly journalHeadDigest: string;
  readonly replayedThroughActionIndex: number;
  readonly replayChainDigest: string;
  readonly restoreNonce: string;
}

export interface RestoredFrontierProof {
  readonly restoreTicket: string;
  readonly frontierDigest: string;
}

export interface IssueRestoreTicketRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly activationEpoch: number;
  readonly replayedThroughActionIndex: number;
  readonly replayChainDigest: string;
}

export interface IssueRestoreTicketResult {
  readonly restoreTicket: string;
  readonly taskRevision: number;
  readonly journalHeadDigest: string;
}

export interface PrepareProgramRestoreRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly activationEpoch: number;
  readonly releaseId: string;
  readonly sandboxSessionId: string;
  readonly replayDomain: string;
  readonly frontierDomain: string;
}

export interface PreparedProgramRestore {
  readonly restoreTicket: string;
  readonly replay: readonly ReplayEntry[];
  readonly replayedThroughActionIndex: number;
  readonly replayChainSeed: string;
  readonly replayChainDigest: string;
  readonly taskRevision: number;
  readonly journalHeadDigest: string;
}

export interface BindRestoreFrontierRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly activationEpoch: number;
  readonly restoreTicket: string;
  readonly frontierDigest: string;
}

export type BindRestoreFrontierResult =
  | { readonly status: "bound"; readonly proof: RestoredFrontierProof }
  | { readonly status: "restore_stale" };

export interface ConsumeRestoreTicketRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly ownerId: string;
  readonly activationEpoch: number;
  readonly proof: RestoredFrontierProof;
}

export type ConsumeRestoreTicketResult =
  | { readonly status: "consumed" }
  | {
      readonly status: "restore_stale";
      readonly consecutiveStales: number;
      readonly retryAfterMs: number;
      readonly releaseRequired: boolean;
    };

/** Task-local durable boundary fixed by the first accepted cancellation. */
export interface CancellationFrontier {
  actionIndex: number;
  pullId?: string;
}

/** Durable lifecycle of one explicit cancellation command. */
export type DurableCancellationState =
  | { type: "none" }
  | { type: "requested"; commandId: string; reason?: string; frontier: CancellationFrontier }
  | {
      type: "settling_effect";
      commandId: string;
      pullId: string;
      reason?: string;
      frontier: CancellationFrontier;
    }
  | {
      type: "cancelling_children";
      commandId: string;
      childTaskIds: readonly string[];
      reason?: string;
      frontier: CancellationFrontier;
    }
  | { type: "unwinding"; commandId: string; reason?: string; frontier: CancellationFrontier }
  | { type: "cancelled"; commandId: string }
  | {
      type: "orphaned";
      reason:
        | "program_version_unavailable"
        | "program_corrupt"
        | "cleanup_stuck"
        | "replay_execution_failed"
        | "replay_diverged";
    };

/** Idempotent acknowledgement of the first durable cancellation request. */
export interface CancellationAcknowledgement {
  accepted: true;
  duplicate: boolean;
  commandId: string;
  reason?: string;
  frontier: CancellationFrontier;
}

/** Exact authenticated claims authorizing program proposal and completion. */
export interface ProgramExecutionCapabilityClaims {
  version: 1;
  issuer: string;
  keyId: string;
  journalId: string;
  journalIncarnation: string;
  sessionId: string;
  taskId: string;
  programId: string;
  programVersion: string;
  programDigest: string;
  attachmentId: string;
  executionEpoch: number;
  audience: string;
  permissions: ["propose", "complete"];
  nonce: string;
}

/** Exact authenticated claims authorizing one audience-bound pull resolution. */
export interface ResolutionCapabilityClaims {
  version: 1;
  issuer: string;
  keyId: string;
  journalId: string;
  journalIncarnation: string;
  sessionId: string;
  taskId: string;
  pullId: string;
  descriptorDigest: string;
  resultSchemaDigest: string;
  attemptId: string;
  audience: string;
  permissions: ["resolve"];
  maxOutcomeBytes: number;
  nonce: string;
}

/** Closed authenticated capability claim algebra. */
export type CapabilityClaims = ProgramExecutionCapabilityClaims | ResolutionCapabilityClaims;

/** Program-authorized request to reserve an ordered operation before dispatch. */
export interface ReserveOperationRequest {
  sessionId: string;
  turnId: string;
  taskId: string;
  actionIndex: number;
  pullIndex: number;
  descriptor: DurableOperationDescriptor;
  programCapability: string;
  restoredFrontier?: RestoredFrontierProof;
  restoredFrontierStep?: ProgramStep;
}

/** Reserve result distinguishing replay, host authorization, and durable parking. */
export type ReserveOperationResult =
  | {
      status: "resolved";
      outcome: OperationOutcome;
      receipt: ResolutionReceipt;
      restoredFrontierConsumed?: true;
    }
  | {
      status: "authorized";
      pullId: string;
      attemptId: string;
      /** Canonical effect or execution-owned record accepted by the authority. */
      descriptor: EffectDescriptor | RecordedOperationDescriptor;
      /** Present only for installed effects. */
      effectContractDigest?: string;
      /** Exact manifest definition present only for installed effects. */
      effectDefinition?: EffectDefinition<Json, Json, Json>;
      resolutionCapability: string;
      notBefore?: string;
      restoredFrontierConsumed?: true;
    }
  | {
      status: "pending";
      pullId: string;
      reason: "elicit" | "wait" | "child";
      resolutionCapability?: string;
      restoredFrontierConsumed?: true;
    };

/** Capability-bearing request to commit one canonical operation outcome. */
export interface ResolveOperationRequest {
  capability: string;
  audience: string;
  outcome: OperationOutcome;
}

/** Expected resolution result algebra; rejection reasons are stable values. */
export type ResolveOperationResult =
  | { status: "accepted" | "duplicate"; receipt: ResolutionReceipt }
  | {
      status: "rejected";
      code:
        | "invalid_resolution_capability"
        | "wrong_audience"
        | "capability_revoked"
        | "pull_not_found"
        | "task_terminal"
        | "payload_too_large"
        | "resolution_conflict"
        | "idempotency_conflict"
        | "schema_validation_failed"
        | "schema_version_unavailable"
        | "wait_not_due";
    };

/** Program-authorized request to append an ordered durable emission. */
export interface AppendEmissionRequest {
  sessionId: string;
  taskId: string;
  actionIndex: number;
  descriptor: EmissionDescriptor;
  programCapability: string;
  restoredFrontier?: RestoredFrontierProof;
  restoredFrontierStep?: ProgramStep;
}

/** Stable receipt identifying an appended or duplicate emission. */
export interface EmissionReceipt {
  offset: string;
  eventId: string;
  duplicate: boolean;
  restoredFrontierConsumed?: true;
}

/** Program-authorized request to close a task with a schema-valid outcome. */
export interface CompleteTaskRequest {
  sessionId: string;
  taskId: string;
  actionIndex: number;
  outcome: OperationOutcome;
  programCapability: string;
  restoredFrontier?: RestoredFrontierProof;
  restoredFrontierStep?: ProgramStep;
}

/** Stable receipt identifying task closure or idempotent replay. */
export interface TaskCloseReceipt {
  offset: string;
  duplicate: boolean;
  restoredFrontierConsumed?: true;
}

/** Complete deterministic child-allocation request tied to a parent pull. */
export interface EnsureChildTaskRequest {
  sessionId: string;
  turnId: string;
  parentTaskId: string;
  parentPullId: string;
  child: DurableChildDescriptor;
  manifest: DurableProgramManifest;
  executionEpoch: number;
  audience: string;
  /** Authority-accepted child route retained for process-replacement recovery. */
  route?: ProgramRoute;
}

/** Child allocation result, including an already-recorded terminal outcome when present. */
export interface EnsureChildTaskResult {
  taskId: string;
  outcome?: OperationOutcome;
}

export interface DurableTaskExecutionState {
  readonly route?: ProgramRoute;
  readonly executionEpoch: number;
  readonly catalog?: Json;
  readonly catalogDigest?: string;
}

/** Narrow authority port mediating every durable state transition. */
export interface DurableJournalAuthorityService {
  /** Host-private stable journal identity used by placement effect services. */
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  /** Reads authority-owned placement/catalog state without exposing capabilities. */
  taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  /** Returns the canonical parsed input accepted for a task; replay never reruns schema code. */
  taskInput(sessionId: string, taskId: string): Operation<Json>;
  /** Lists exact schema digests referenced by nonterminal durable tasks for readiness/retirement. */
  nonterminalSchemaDigests(): Operation<string[]>;
  /** Legacy local activation marker. Distributed coordinators use claimActivation. */
  markActivationStarted(sessionId: string): Operation<void>;
  /** Lists runnable work plus expired in-flight ownership for restart recovery. */
  recoverableSessions(): Operation<RecoverableSession[]>;
  /** Claims absent/expired runnable work under an authority-minted epoch. */
  claimActivation(request: ClaimActivationRequest): Operation<ClaimActivationResult>;
  /** Renews only the exact current owner and epoch using authority time. */
  renewActivation(request: RenewActivationRequest): Operation<RenewActivationResult>;
  /** Releases exact ownership and re-derives runnable state without losing wakeups. */
  releaseActivation(request: ReleaseActivationRequest): Operation<ReleaseActivationResult>;
  /** Issues a host-private single-use ticket for one authority snapshot. */
  issueRestoreTicket(request: IssueRestoreTicketRequest): Operation<IssueRestoreTicketResult>;
  /** Derives one integrity-linked replay plan and ticket from the claimed snapshot. */
  prepareProgramRestore(request: PrepareProgramRestoreRequest): Operation<PreparedProgramRestore>;
  /** Binds the host-verified remote frontier digest without consuming the ticket. */
  bindRestoreFrontier(request: BindRestoreFrontierRequest): Operation<BindRestoreFrontierResult>;
  /** Atomically verifies and consumes one first-live-frontier ticket. */
  consumeRestoreTicket(request: ConsumeRestoreTicketRequest): Operation<ConsumeRestoreTicketResult>;
  /** Reads the durable cancellation state used by fresh replay attachments. */
  cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState>;
  /** Transitions a settled cancellation frontier into one-shot unwind. */
  beginCancellationUnwind(
    sessionId: string,
    taskId: string,
    restoredFrontier?: { readonly proof: RestoredFrontierProof; readonly step: ProgramStep },
  ): Operation<DurableCancellationState>;
  /** Binds program authority to one attachment and execution epoch. */
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  /** Idempotently allocates a deterministic child task. */
  ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
  /** Reserves an operation before any host side effect is dispatched. */
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  /** Commits a capability-authorized operation outcome. */
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  /** Appends an ordered durable emission idempotently. */
  emit(request: AppendEmissionRequest): Operation<EmissionReceipt>;
  /** Closes a task idempotently after output validation. */
  complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt>;
  /** Fences a task whose execution cannot be reconstructed through accepted history. */
  forceOrphan(
    sessionId: string,
    taskId: string,
    reason:
      | "program_version_unavailable"
      | "program_corrupt"
      | "cleanup_stuck"
      | "replay_execution_failed"
      | "replay_diverged",
  ): Operation<void>;
}
