/**
 * Journal authority declarations.
 *
 * The operations a journal authority exposes and the request/result pairs that
 * carry them: activation leases, restore tickets, reserve/resolve, cancellation
 * and completion. Depends on the contract and protocol layers.
 */

import type { IdentityConflict, Json } from "@sweatpants/foundation";
import type {
  EffectDefinition,
  EffectDescriptor,
  OperationOutcome,
} from "@sweatpants/durable-effects";
import type {
  DeliveryMandate,
  DurableChildDescriptor,
  DurableOperationDescriptor,
  DurableProgramManifest,
  DurableSampleDescriptor,
  EmissionDescriptor,
  LivePlacement,
  Mandate,
  PeerReadyTarget,
  ProgramRoute,
  ProgramCheckpoint,
  TurnAddress,
  ProgramStep,
  RecordedOperationDescriptor,
  ReplayEntry,
  ResolutionReceipt,
} from "@sweatpants/durable-execution";
import type { ForkExpiryPolicy, ForkGroupTerminal } from "../forest/fork-group.ts";

/** Private, authority-time activation ownership state. */
export interface ActivationLeaseState {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly epoch: number;
  readonly expiresAtMs: number;
  readonly leaseDurationMs: number;
  readonly claimedTaskRevision: number;
  readonly claimedHeadId: string;
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
      readonly journalHeadId: string;
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
  readonly journalHeadId: string;
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
  readonly journalHeadId: string;
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
  readonly journalHeadId: string;
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
      type: "settling_pull";
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

/**
 * DeliveryMandate claims (REQ-074): proposal rights only for one peer
 * member's evidence strand — journal-first delivery acknowledgement and
 * evidence/loss proposals under one correlator. Never program, resolution,
 * restore, or participant authority (REQ-040).
 */
export interface DeliveryCapabilityClaims {
  version: 1;
  issuer: string;
  keyId: string;
  journalId: string;
  journalIncarnation: string;
  sessionId: string;
  taskId: string;
  groupId: string;
  memberTaskId: string;
  correlator: string;
  audience: string;
  permissions: ["deliver"];
  nonce: string;
}

/** Closed authenticated capability claim algebra. */
export type CapabilityClaims =
  | ProgramExecutionCapabilityClaims
  | ResolutionCapabilityClaims
  | DeliveryCapabilityClaims;

/** Complete root/child identity and pinned input required to open a task. */
export interface OpenDurableTaskRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly taskId: string;
  readonly manifest: DurableProgramManifest;
  readonly input: Json;
  readonly executionEpoch: number;
  readonly attachmentId: string;
  readonly audience: string;
  readonly elicitAudience?: string;
  readonly catalog?: Json;
  readonly catalogDigest?: string;
  readonly route?: ProgramRoute;
  readonly parentTaskId?: string;
  readonly parentPullId?: string;
  /**
   * Session-root expiry policy source (REQ-030). Roots may declare `at` or
   * `after`; descendants resolve fork deadlines against the inherited cap.
   * Absent means no policy, which makes `inherit` fork admission fail closed.
   */
  readonly expiryPolicy?: ForkExpiryPolicy;
}

/** Plain bind proposal; runtime handles never cross the decision boundary. */
export interface BindMandateRequest {
  /** Captured at the proposed frontier; authority supplies the journal anchor. */
  readonly checkpoint?: Extract<ProgramCheckpoint, { kind: "continuation" }>;
  readonly address: TurnAddress;
  readonly strand: string;
  readonly program: { readonly id: string; readonly version: string; readonly digest: string };
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly leaseDurationMs: number;
  readonly placement: LivePlacement;
  readonly expected: {
    readonly strandHeadDigest: string;
    readonly leaseEpoch: number;
    readonly forkGroupRevision: number;
  };
  readonly frontierProof: {
    readonly frontierDigest: string;
    readonly strandHeadDigest: string;
    readonly replayedThroughActionIndex: number;
    readonly replayChainDigest: string;
    readonly cancellationReplayed: boolean;
  };
}

export type BindMandateResult =
  | { readonly status: "bound"; readonly mandate: Mandate }
  | {
      readonly status: "stale";
      readonly mismatch: "strand_head" | "lease_epoch" | "fork_group_revision";
    };

/** Peer bind uses the same atomic head/epoch/group CAS as crank-native bind. */
export interface BindDeliveryMandateRequest {
  readonly ready: PeerReadyTarget;
  readonly attachmentId: string;
  readonly ownerId: string;
  readonly leaseDurationMs: number;
  readonly placement: LivePlacement;
  readonly expected: {
    readonly strandHeadDigest: string;
    readonly leaseEpoch: number;
    readonly forkGroupRevision: number;
  };
}

export type BindDeliveryMandateResult =
  | { readonly status: "bound"; readonly mandate: DeliveryMandate }
  | {
      readonly status: "stale";
      readonly mismatch: "strand_head" | "lease_epoch" | "fork_group_revision";
    };

export interface ReleaseMandateRequest {
  readonly mandate: Mandate;
  readonly reason: "parked" | "settled" | "terminal" | "failed" | "scope_exit";
}

export type ReleaseMandateResult = { readonly status: "released" } | { readonly status: "stale" };

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

/** Opt-in recovery of one unknown repeatable record; never used by default drivers. */
export interface RecoverRecordRequest {
  /** Replacement ownership and trusted-host reconstruction evidence. */
  replacement: BindMandateRequest;
  sessionId: string;
  turnId: string;
  taskId: string;
  actionIndex: number;
  pullIndex: number;
  pullId: string;
  expectedAttemptId: string;
  descriptor: DurableOperationDescriptor;
  programCapability: string;
}

export type RecoverRecordResult = Extract<ReserveOperationResult, { status: "authorized" }> & {
  mandate: Mandate;
};

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
      reason: "elicit" | "wait" | "child" | "ephemeral" | "sample";
      resolutionCapability?: string;
      restoredFrontierConsumed?: true;
    };

export type LiveReservationResult = Exclude<ReserveOperationResult, { status: "resolved" }>;

/** Mandate-relative live commands: addressing and sequence positions are derived once. */
export interface MandateReserveRequest {
  readonly mandate: Mandate;
  readonly descriptor: DurableOperationDescriptor;
}
export interface MandateEmissionRequest {
  readonly mandate: Mandate;
  readonly descriptor: EmissionDescriptor;
}
export interface MandateCompleteRequest {
  readonly mandate: Mandate;
  readonly outcome: OperationOutcome;
}

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

/**
 * Result of a completion attempt. Value-level policy violations
 * (`schema_validation_failed`, `payload_too_large`) are protocol rejections
 * returned as data — programs author values the authority may refuse —
 * while contract violations (unknown task, stale capability,
 * `nondeterminism_detected`, `history_not_exhausted`) remain exceptions.
 */
export type CompleteTaskResult =
  | { readonly status: "accepted"; readonly receipt: TaskCloseReceipt }
  | { readonly status: "duplicate"; readonly receipt: TaskCloseReceipt }
  | { readonly status: "rejected"; readonly code: string; readonly message: string };

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

/** One fork-group member opening request (REQ-024: members run as roots). */
export interface ForkGroupMemberRequest {
  readonly child: DurableChildDescriptor;
  readonly manifest: DurableProgramManifest;
  readonly route?: ProgramRoute;
}

/**
 * Atomic, idempotent fork-group admission (REQ-021, REQ-023, REQ-030).
 * Opens the group row and every member row in one commit; a retry with the
 * same descriptor digest returns the recorded opening. Policy and expiry
 * derive from the accepted fork descriptor — the descriptor is the only
 * source of truth, so no request field can drift from it.
 */
export interface OpenForkGroupRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly parentTaskId: string;
  readonly parentPullId: string;
  readonly members: readonly ForkGroupMemberRequest[];
  readonly executionEpoch: number;
  readonly audience: string;
}

export interface OpenForkGroupResult {
  readonly status: "opened" | "duplicate";
  readonly groupId: string;
  readonly deadlineMs: number;
  readonly memberTaskIds: readonly string[];
}

/** Clock-driven expiry breach (REQ-031). Commits the breach record, starts
 *  leaves-first member cancellation, and resolves the group only once every
 *  member is terminal. Loses to an earlier group resolution with a typed
 *  `fork_group_terminal` rejection (REQ-032). */
export interface BreachForkGroupRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly groupId: string;
}

export interface BreachForkGroupResult {
  readonly groupId: string;
  readonly cancelMembers: readonly string[];
  readonly resolution?: ForkGroupTerminal;
}

/** Separately authorized force-orphan of a stuck group (REQ-034). */
export interface ForceOrphanForkGroupRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly groupId: string;
  readonly reason: string;
}

export interface ForceOrphanForkGroupResult {
  readonly resolution: ForkGroupTerminal;
}

/**
 * Journal-first peer delegation (REQ-038): commits the delivery record and
 * uses a previously CAS-issued DeliveryMandate and returns its stable
 * correlator. Retries under the same correlator dedupe; no send may precede
 * this commit.
 */
export interface CommitPeerDelegationRequest {
  readonly mandate: DeliveryMandate;
}

export interface CommitPeerDelegationResult {
  readonly status: "committed" | "duplicate";
  readonly correlator: string;
}

/** Peer terminal evidence proposed under the DeliveryMandate (REQ-074):
 *  the authority validates and commits; the mandate never mutates directly. */
export interface ReserveDelegatedPeerSampleRequest {
  readonly mandate: DeliveryMandate;
  readonly descriptor: DurableSampleDescriptor;
}

export type ReserveDelegatedPeerSampleResult = Extract<
  LiveReservationResult,
  { readonly status: "pending" }
>;

export interface CommitPeerEvidenceRequest {
  readonly mandate: DeliveryMandate;
  readonly correlator: string;
  readonly outcome: OperationOutcome;
}

export interface CommitPeerEvidenceResult {
  readonly status: "accepted";
}

/** Typed peer loss report (REQ-043): closes the member with a journaled
 *  `peer_lost` outcome that flows through the group supervision policy. */
export interface ReportPeerLossRequest {
  readonly mandate: DeliveryMandate;
  readonly correlator: string;
  readonly reason: string;
}

export interface ReportPeerLossResult {
  readonly status: "accepted";
}

export interface DurableTaskExecutionState {
  readonly route?: ProgramRoute;
  readonly executionEpoch: number;
  readonly catalog?: Json;
  readonly catalogDigest?: string;
}

/**
 * Narrow recovery selection owned by the Authority.
 *
 * The Host asks for work; it does not download the semantic journal and rebuild
 * Authority state in process. A requested active child resolves to its active
 * root, matching structured execution ownership. Terminal outcomes are returned
 * as values so an idempotent resume does not require a journal scan either.
 */
export type DurableTaskRecoveryState =
  | {
      readonly status: "active";
      readonly sessionId: string;
      readonly turnId: string;
      readonly taskId: string;
      readonly manifest: DurableProgramManifest;
      readonly input: Json;
      /** Every nonterminal task fenced with the selected root as one tree. */
      readonly activeTasks: readonly {
        readonly taskId: string;
        readonly executionEpoch: number;
        readonly attachmentId: string;
      }[];
    }
  | {
      readonly status: "terminal";
      readonly taskId: string;
      readonly outcome: OperationOutcome;
    }
  | { readonly status: "not_found" };

/** Narrow operation lookup used by command handlers without exposing the journal. */
export type DurableOperationState =
  | {
      readonly status: "found";
      readonly descriptor: DurableOperationDescriptor;
      readonly audience: string;
      readonly outcome?: OperationOutcome;
    }
  | { readonly status: "not_found" };

export interface ValidateElicitResponseRequest {
  readonly sessionId: string;
  readonly pullId: string;
  readonly participantId: string;
  readonly completion: Json;
}

export type ValidateElicitResponseResult =
  | {
      readonly status: "valid";
      readonly taskId: string;
      readonly audience: string;
      readonly outcome: OperationOutcome;
    }
  | {
      readonly status:
        | "not_pending"
        | "audience_invalid"
        | "expired"
        | "schema_validation_failed"
        | "schema_version_unavailable";
    };

export type ModelContextPolicyDecision =
  | {
      readonly type: "include-range";
      readonly fromPositionInclusive: string;
      readonly beforePositionExclusive: string;
      readonly reason: string;
    }
  | {
      readonly type: "use-artifact";
      readonly artifactDigest: string;
      readonly firstUncoveredPosition: string;
      readonly reason: string;
    }
  | {
      readonly type: "drop-causal-group";
      readonly fromPositionInclusive: string;
      readonly beforePositionExclusive: string;
      readonly reason: string;
    }
  | {
      readonly type: "history-policy";
      readonly policyId: string;
      readonly action: "drop_turn" | "drop_message";
      readonly reason: string;
      readonly roles: readonly string[];
      readonly toolCallIds: readonly string[];
    };

export interface ModelContextPreparedFact {
  readonly type: "ModelContextPrepared";
  readonly executionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly contextObject: { readonly objectId: string };
  readonly contextDigest: string;
  readonly invocationDigest: string;
  readonly responseModeDigest: string;
  readonly generationOptionsDigest: string;
  readonly sourceCheckpoint: { readonly checkpointId: string };
  readonly sourceArchiveHeadSegmentId: string | null;
  readonly sourceArchiveFrontierOrdinal: string;
  readonly sourceNextPublicPosition: string;
  readonly acceptedCommandId: string;
  readonly policyId: string;
  readonly policyDecisions: readonly ModelContextPolicyDecision[];
  readonly budgetId: string;
  readonly budgetDigest: string;
  readonly toolCatalogDigest: string;
  readonly model: { readonly provider: string; readonly id: string };
  readonly publicMessageId: string;
}

export interface AcceptPullPreparationRequest {
  readonly executionId: string;
  readonly taskId: string;
  readonly pullId: string;
  /** Exact active attempt fence authorizing provider dispatch. */
  readonly expectedOwnerFence: string;
  readonly kind: "model-context";
  readonly fact: ModelContextPreparedFact;
}

export type AcceptPullPreparationResult =
  | { readonly status: "accepted" | "duplicate" }
  | { readonly status: "pull_not_pending" | "stale_owner" }
  | { readonly status: "identity_conflict"; readonly conflict?: IdentityConflict };

export interface AuthorizeModelDispatchRequest {
  readonly executionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly expectedOwnerFence: string;
  readonly invocationDigest: string;
}

export type AuthorizeModelDispatchResult =
  | { readonly status: "authorized"; readonly fact: ModelContextPreparedFact }
  | { readonly status: "pull_not_pending" | "stale_owner" | "not_prepared" }
  | { readonly status: "identity_conflict"; readonly conflict?: IdentityConflict };

export interface AssistantPartialAcceptedFact {
  readonly type: "AssistantPartialAccepted";
  readonly messageId: string;
  readonly text: string;
  readonly disposition: "interrupted" | "provider-error";
}

export interface AcceptAssistantPartialRequest {
  readonly executionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly expectedOwnerFence: string;
  readonly fact: AssistantPartialAcceptedFact;
}

export type AcceptAssistantPartialResult = AcceptPullPreparationResult;
