/**
 * Journal authority declarations.
 *
 * The operations a journal authority exposes and the request/result pairs that
 * carry them: activation leases, restore tickets, reserve/resolve, cancellation
 * and completion. Depends on the contract and protocol layers.
 */

import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type {
  EffectDefinition,
  EffectDescriptor,
  OperationOutcome,
} from "@sweatpants/durable-effects";
import type {
  DurableChildDescriptor,
  DurableOperationDescriptor,
  DurableProgramManifest,
  EmissionDescriptor,
  ProgramRoute,
  ProgramStep,
  RecordedOperationDescriptor,
  ReplayEntry,
  ResolutionReceipt,
} from "@sweatpants/durable-execution";

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
  | {
      readonly status: "pull_not_pending" | "stale_owner" | "identity_conflict";
    };

export interface AuthorizeModelDispatchRequest {
  readonly executionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly expectedOwnerFence: string;
  readonly invocationDigest: string;
}

export type AuthorizeModelDispatchResult =
  | { readonly status: "authorized"; readonly fact: ModelContextPreparedFact }
  | {
      readonly status: "pull_not_pending" | "stale_owner" | "not_prepared" | "identity_conflict";
    };

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

/** Narrow authority port mediating every durable state transition. */
export interface DurableJournalAuthorityService {
  /** Host-private stable journal identity used by placement effect services. */
  journalIdentity(): { readonly id: string; readonly incarnation: string };
  /** Reads authority-owned placement/catalog state without exposing capabilities. */
  taskExecutionState(sessionId: string, taskId: string): Operation<DurableTaskExecutionState>;
  /** Returns the canonical parsed input accepted for a task; replay never reruns schema code. */
  taskInput(sessionId: string, taskId: string): Operation<Json>;
  /** Selects active root work or its terminal value without exposing the journal. */
  taskRecoveryState(
    sessionId: string,
    requestedTaskId?: string,
  ): Operation<DurableTaskRecoveryState>;
  /** Counts accepted roots for deterministic local Turn-id allocation. */
  rootTaskCount(sessionId: string): Operation<number>;
  /** Looks up one operation without exposing private capabilities or the journal. */
  operationState(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<DurableOperationState>;
  /** Validates an exact pending elicitation without mutating durable authority. */
  validateElicitResponse(
    request: ValidateElicitResponseRequest,
  ): Operation<ValidateElicitResponseResult>;
  /** Lists exact schema digests referenced by nonterminal durable tasks for readiness/retirement. */
  nonterminalSchemaDigests(): Operation<string[]>;
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
  /** Returns accepted model preparation identity without exposing other journal state. */
  pullPreparation(
    sessionId: string,
    taskId: string,
    pullId: string,
  ): Operation<ModelContextPreparedFact | null>;
  /** Accepts immutable provider-input identity before any model dispatch. */
  acceptPullPreparation(
    request: AcceptPullPreparationRequest,
  ): Operation<AcceptPullPreparationResult>;
  /** Rechecks the accepted preparation and current attempt immediately before provider I/O. */
  authorizeModelDispatch(
    request: AuthorizeModelDispatchRequest,
  ): Operation<AuthorizeModelDispatchResult>;
  /** Accepts one typed public assistant partial before pull settlement. */
  acceptAssistantPartial(
    request: AcceptAssistantPartialRequest,
  ): Operation<AcceptAssistantPartialResult>;
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
