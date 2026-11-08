import { CrankError } from "@sweatpants/durable-execution";
import type { DocumentCommandRequest } from "./document-command.ts";
import type { OperationOutcome } from "@sweatpants/durable-effects";
import type {
  DocumentResult,
  WorkflowDocumentState,
  DurableOperationDescriptor,
  DurableProgramManifest,
  ForestReplayPlan,
  ReplayItem,
  ReplayEntry,
  PinnedProgram,
  ProgramRoute,
  ProgramRecoveryCheckpoint,
  ProgramStep,
  ResolutionReceipt,
  TurnAddress,
} from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { Operation } from "effection";

import type { CapabilityKeyring } from "./capabilities.ts";
import type { DurableSemanticRecord } from "./semantic-record.ts";
import type {
  AcceptAssistantPartialRequest,
  AcceptAssistantPartialResult,
  AcceptPullPreparationRequest,
  AcceptPullPreparationResult,
  ActivationLeaseState,
  AppendEmissionRequest,
  AssistantPartialAcceptedFact,
  AuthorizeModelDispatchRequest,
  AuthorizeModelDispatchResult,
  BindDeliveryMandateRequest,
  BindDeliveryMandateResult,
  BindMandateRequest,
  BindMandateResult,
  BindRestoreFrontierRequest,
  BindRestoreFrontierResult,
  CancellationAcknowledgement,
  ClaimActivationRequest,
  ClaimActivationResult,
  CompleteTaskRequest,
  CompleteTaskResult,
  ConsumeRestoreTicketRequest,
  ConsumeRestoreTicketResult,
  DurableCancellationState,
  DurableOperationState,
  DurableTaskExecutionState,
  DurableTaskRecoveryState,
  EmissionReceipt,
  EnsureChildTaskRequest,
  EnsureChildTaskResult,
  IssueRestoreTicketRequest,
  IssueRestoreTicketResult,
  LiveReservationResult,
  MandateCompleteRequest,
  MandateEmissionRequest,
  MandateReserveRequest,
  ModelContextPreparedFact,
  OpenDurableTaskRequest,
  PrepareProgramRestoreRequest,
  PreparedProgramRestore,
  RecoverableSession,
  ReleaseActivationRequest,
  ReleaseActivationResult,
  ReleaseMandateRequest,
  ReleaseMandateResult,
  RenewActivationRequest,
  RenewActivationResult,
  ResolveOperationRequest,
  ResolveOperationResult,
  RestoredFrontierProof,
  TaskCloseReceipt,
  ValidateElicitResponseRequest,
  ValidateElicitResponseResult,
  RecoverRecordRequest,
  RecoverRecordResult,
  ReserveOperationRequest,
  ReserveOperationResult,
  BreachForkGroupRequest,
  BreachForkGroupResult,
  ForceOrphanForkGroupRequest,
  ForceOrphanForkGroupResult,
  OpenForkGroupRequest,
  OpenForkGroupResult,
  CommitPeerDelegationRequest,
  CommitPeerDelegationResult,
  CommitPeerEvidenceRequest,
  CommitPeerEvidenceResult,
  ReportPeerLossRequest,
  ReportPeerLossResult,
  ReserveDelegatedPeerSampleRequest,
  ReserveDelegatedPeerSampleResult,
} from "./authority-types.ts";
import type { ForkGroupState } from "../forest/fork-group.ts";
import type { DurableSchemaRegistry } from "./schema-registry.ts";

export type DecisionStageName =
  | "decision-diagnostics"
  | "semantic-consistency"
  | "structural-validation"
  | "common-idempotency"
  | "exhaustive-dispatcher";

export interface DecisionStageDiagnostic {
  readonly phase: "enter" | "complete" | "reject";
  readonly stage: DecisionStageName;
  readonly command: string;
  readonly category?: string;
}

export interface SemanticEmissionPolicy {
  maxEmissionsPerTask?: number;
  maxCumulativeEmissionBytes?: number;
}

export interface BindAttachmentCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly attachmentId: string;
  readonly executionEpoch: number;
}

export interface ReplaceAttachmentCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly attachmentId: string;
  readonly audience?: string;
}

export interface RequestCancellationCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly reason?: string;
  readonly commandId?: string;
}

export interface BeginCancellationUnwindCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly restoredFrontier?: {
    readonly proof: RestoredFrontierProof;
    readonly step: ProgramStep;
  };
}

export interface DetachAttemptCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly reason?: string;
}

export interface AbandonAttemptCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly pullId: string;
  readonly attemptId: string;
  readonly reason?: string;
}

export type OrphanReason =
  | "program_version_unavailable"
  | "program_corrupt"
  | "cleanup_stuck"
  | "replay_execution_failed"
  | "replay_diverged";

export interface ForceOrphanCommand {
  readonly sessionId: string;
  readonly taskId: string;
  readonly reason: OrphanReason;
}

export type ExecutionCommand =
  | { readonly type: "execution.open-task"; readonly request: OpenDurableTaskRequest }
  | { readonly type: "execution.bind-attachment"; readonly request: BindAttachmentCommand }
  | { readonly type: "execution.bind-mandate"; readonly request: BindMandateRequest }
  | {
      readonly type: "execution.bind-delivery-mandate";
      readonly request: BindDeliveryMandateRequest;
    }
  | { readonly type: "execution.release-mandate"; readonly request: ReleaseMandateRequest }
  | { readonly type: "execution.replace-attachment"; readonly request: ReplaceAttachmentCommand }
  | { readonly type: "execution.ensure-child"; readonly request: EnsureChildTaskRequest }
  | { readonly type: "execution.open-fork-group"; readonly request: OpenForkGroupRequest }
  | { readonly type: "execution.breach-fork-group"; readonly request: BreachForkGroupRequest }
  | {
      readonly type: "execution.force-orphan-fork-group";
      readonly request: ForceOrphanForkGroupRequest;
    }
  | {
      readonly type: "execution.commit-peer-delegation";
      readonly request: CommitPeerDelegationRequest;
    }
  | {
      readonly type: "execution.commit-peer-evidence";
      readonly request: CommitPeerEvidenceRequest;
    }
  | {
      readonly type: "execution.reserve-delegated-peer-sample";
      readonly request: ReserveDelegatedPeerSampleRequest;
    }
  | { readonly type: "execution.report-peer-loss"; readonly request: ReportPeerLossRequest }
  | { readonly type: "execution.recover-record"; readonly request: RecoverRecordRequest }
  | { readonly type: "execution.reserve-pull"; readonly request: ReserveOperationRequest }
  | { readonly type: "execution.mandate-reserve"; readonly request: MandateReserveRequest }
  | { readonly type: "execution.mandate-emission"; readonly request: MandateEmissionRequest }
  | { readonly type: "execution.mandate-complete"; readonly request: MandateCompleteRequest }
  | {
      readonly type: "execution.accept-preparation";
      readonly request: AcceptPullPreparationRequest;
    }
  | {
      readonly type: "execution.accept-assistant-partial";
      readonly request: AcceptAssistantPartialRequest;
    }
  | { readonly type: "execution.resolve-pull"; readonly request: ResolveOperationRequest }
  | { readonly type: "execution.append-emission"; readonly request: AppendEmissionRequest }
  | { readonly type: "execution.complete-task"; readonly request: CompleteTaskRequest }
  | {
      readonly type: "execution.request-cancellation";
      readonly request: RequestCancellationCommand;
    }
  | {
      readonly type: "execution.begin-cancellation-unwind";
      readonly request: BeginCancellationUnwindCommand;
    }
  | { readonly type: "execution.detach-attempt"; readonly request: DetachAttemptCommand }
  | { readonly type: "execution.abandon-attempt"; readonly request: AbandonAttemptCommand }
  | {
      readonly type: "execution.orphan-if-current";
      readonly request: { readonly fence: OrphanFence; readonly reason: "replay_diverged" };
    }
  | { readonly type: "execution.force-orphan"; readonly request: ForceOrphanCommand };

export type ActivationControlCommand =
  | { readonly type: "control.claim-activation"; readonly request: ClaimActivationRequest }
  | { readonly type: "control.renew-activation"; readonly request: RenewActivationRequest }
  | { readonly type: "control.release-activation"; readonly request: ReleaseActivationRequest };

export type RecoveryCommand =
  | { readonly type: "recovery.issue-ticket"; readonly request: IssueRestoreTicketRequest }
  | { readonly type: "recovery.prepare-restore"; readonly request: PrepareProgramRestoreRequest }
  | { readonly type: "recovery.bind-frontier"; readonly request: BindRestoreFrontierRequest }
  | { readonly type: "recovery.consume-ticket"; readonly request: ConsumeRestoreTicketRequest };

export type AuthorityCommand =
  | ExecutionCommand
  | ActivationControlCommand
  | RecoveryCommand
  | { readonly type: "document.operate"; readonly request: DocumentCommandRequest };

export interface CommandResultByType {
  readonly "document.operate": DocumentResult;
  readonly "execution.open-task": { readonly programCapability: string };
  readonly "execution.bind-attachment": { readonly programCapability: string };
  readonly "execution.bind-mandate": BindMandateResult;
  readonly "execution.bind-delivery-mandate": BindDeliveryMandateResult;
  readonly "execution.release-mandate": ReleaseMandateResult;
  readonly "execution.replace-attachment": {
    readonly executionEpoch: number;
    readonly programCapability: string;
  };
  readonly "execution.ensure-child": EnsureChildTaskResult;
  readonly "execution.open-fork-group": OpenForkGroupResult;
  readonly "execution.breach-fork-group": BreachForkGroupResult;
  readonly "execution.force-orphan-fork-group": ForceOrphanForkGroupResult;
  readonly "execution.commit-peer-delegation": CommitPeerDelegationResult;
  readonly "execution.commit-peer-evidence": CommitPeerEvidenceResult;
  readonly "execution.reserve-delegated-peer-sample": ReserveDelegatedPeerSampleResult;
  readonly "execution.report-peer-loss": ReportPeerLossResult;
  readonly "execution.recover-record": RecoverRecordResult;
  readonly "execution.reserve-pull": ReserveOperationResult;
  readonly "execution.mandate-reserve": LiveReservationResult;
  readonly "execution.mandate-emission": EmissionReceipt;
  readonly "execution.mandate-complete": CompleteTaskResult;
  readonly "execution.accept-preparation": AcceptPullPreparationResult;
  readonly "execution.accept-assistant-partial": AcceptAssistantPartialResult;
  readonly "execution.resolve-pull": ResolveOperationResult;
  readonly "execution.append-emission": EmissionReceipt;
  readonly "execution.complete-task": CompleteTaskResult;
  readonly "execution.request-cancellation": CancellationAcknowledgement;
  readonly "execution.begin-cancellation-unwind": DurableCancellationState;
  readonly "execution.detach-attempt": void;
  readonly "execution.abandon-attempt": void;
  readonly "execution.orphan-if-current": { readonly status: "orphaned" | "stale" };
  readonly "execution.force-orphan": void;
  readonly "control.claim-activation": ClaimActivationResult;
  readonly "control.renew-activation": RenewActivationResult;
  readonly "control.release-activation": ReleaseActivationResult;
  readonly "recovery.issue-ticket": IssueRestoreTicketResult;
  readonly "recovery.prepare-restore": PreparedProgramRestore;
  readonly "recovery.bind-frontier": BindRestoreFrontierResult;
  readonly "recovery.consume-ticket": ConsumeRestoreTicketResult;
}

export type CommandResult<C extends AuthorityCommand> = CommandResultByType[C["type"]];

/**
 * Current-state reads. The two `pull.*` validation variants are guarded,
 * read-only checks: they authenticate and validate a proposed interaction but
 * never mint a capability, append history, or advance authority state.
 */
/** Read-only evidence, never a runnable classification or dispatch permission. */
export interface RecordRecoveryObservation {
  readonly item: ReplayItem;
  readonly attachmentId: string;
  readonly pending: {
    readonly actionIndex: number;
    readonly pullIndex: number;
    readonly pullId: string;
    readonly expectedAttemptId: string;
    readonly descriptor: DurableOperationDescriptor;
  };
}

/** Consistency witness for accepted history, never execution authority. */
export interface AcceptedPrefixAnchor {
  readonly address: ReplayItem["address"];
  readonly strand: ReplayItem["strand"];
  readonly program: ReplayItem["program"];
  readonly replayChainSeed: string;
  readonly throughActionIndex: number;
  readonly replayChainDigest: string;
}
export interface AcceptedExtensionRequest {
  readonly anchor: AcceptedPrefixAnchor;
  readonly settled: {
    readonly actionIndex: number;
    readonly receipt: ResolutionReceipt;
  };
}
export interface AcceptedExtensionObservation {
  readonly anchor: AcceptedPrefixAnchor;
  readonly entries: readonly ReplayEntry[];
  readonly plannedHead: ReplayItem["plannedHead"];
  readonly executionEpoch: number;
  readonly groupContext: ReplayItem["groupContext"];
  readonly replayedThroughActionIndex: number;
  readonly replayChainDigest: string;
  readonly cancellationReplayed: boolean;
}

export type AuthorityQuery =
  | { readonly type: "task.accepted-extension"; readonly request: AcceptedExtensionRequest }
  | {
      readonly type: "task.record-recovery-observation";
      readonly sessionId: string;
      readonly taskId: string;
    }
  | { readonly type: "control.activation-status"; readonly sessionId: string }
  | { readonly type: "authority.identity" }
  | { readonly type: "authority.nonterminal-schema-digests" }
  | { readonly type: "authority.recoverable-sessions" }
  | { readonly type: "authority.runnable-sessions" }
  | { readonly type: "forest.replay-plan"; readonly sessionId: string }
  | { readonly type: "session.root-task-count"; readonly sessionId: string }
  | { readonly type: "task.execution-state"; readonly sessionId: string; readonly taskId: string }
  | { readonly type: "task.input"; readonly sessionId: string; readonly taskId: string }
  | { readonly type: "task.address"; readonly sessionId: string; readonly taskId: string }
  | { readonly type: "task.recovery-state"; readonly sessionId: string; readonly taskId?: string }
  | {
      readonly type: "task.cancellation-state";
      readonly sessionId: string;
      readonly taskId: string;
    }
  | {
      readonly type: "task.lifecycle";
      readonly sessionId: string;
      readonly taskId: string;
    }
  | {
      readonly type: "pull.state";
      readonly sessionId: string;
      readonly taskId: string;
      readonly pullId: string;
    }
  | {
      readonly type: "pull.preparation";
      readonly sessionId: string;
      readonly taskId: string;
      readonly pullId: string;
    }
  | {
      readonly type: "pull.validate-elicit-response";
      readonly request: ValidateElicitResponseRequest;
    }
  | {
      readonly type: "pull.authorize-model-dispatch";
      readonly request: AuthorizeModelDispatchRequest;
    }
  | {
      /** Non-attempt pulls only; attempt owners must use authenticated reservation. */
      readonly type: "pull.resolution-capability";
      readonly sessionId: string;
      readonly taskId: string;
      readonly pullId: string;
    };

export interface QueryResultByType {
  readonly "task.accepted-extension": AcceptedExtensionObservation;
  readonly "task.record-recovery-observation": RecordRecoveryObservation;
  readonly "control.activation-status": { readonly remainingMs: number };
  readonly "authority.identity": { readonly id: string; readonly incarnation: string };
  readonly "authority.nonterminal-schema-digests": readonly string[];
  readonly "authority.recoverable-sessions": readonly RecoverableSession[];
  readonly "authority.runnable-sessions": readonly string[];
  readonly "forest.replay-plan": ForestReplayPlan;
  readonly "session.root-task-count": number;
  readonly "task.execution-state": DurableTaskExecutionState;
  readonly "task.input": Json;
  readonly "task.address": TurnAddress;
  readonly "task.recovery-state": DurableTaskRecoveryState;
  readonly "task.cancellation-state": DurableCancellationState;
  readonly "task.lifecycle": {
    readonly status: "active" | "closed" | "cancelled" | "orphaned";
  };
  readonly "pull.state": DurableOperationState;
  readonly "pull.preparation": ModelContextPreparedFact | null;
  readonly "pull.validate-elicit-response": ValidateElicitResponseResult;
  readonly "pull.authorize-model-dispatch": AuthorizeModelDispatchResult;
  readonly "pull.resolution-capability": string;
}

export type QueryResult<Q extends AuthorityQuery> = QueryResultByType[Q["type"]];

export interface JournalAuthorityContract {
  command<C extends AuthorityCommand>(command: C): Operation<CommandResult<C>>;
  query<Q extends AuthorityQuery>(query: Q): Operation<QueryResult<Q>>;
}

export interface AuthoritySnapshotContract {
  exportSnapshot(): Operation<DurableAuthoritySnapshot>;
}

export interface AuthorityJournalContract {
  readSession(sessionId: string): Operation<readonly DurableSemanticRecord[]>;
  readTree(sessionId: string, rootTaskId: string): Operation<readonly DurableSemanticRecord[]>;
}

export type TaskOrigin =
  | { readonly kind: "root" }
  | {
      readonly kind: "child";
      readonly invokedBy: { readonly taskId: string; readonly pullId: string };
    };

export type ActiveCancellationState = Exclude<
  DurableCancellationState,
  { readonly type: "cancelled" | "orphaned" }
>;

export type TaskLifecycle =
  | { readonly status: "active"; readonly cancellation: ActiveCancellationState }
  | {
      readonly status: "closed";
      readonly outcome: OperationOutcome;
      readonly receipt: TaskCloseReceipt;
    }
  | {
      readonly status: "cancelled";
      readonly outcome: Extract<OperationOutcome, { readonly status: "cancelled" }>;
      readonly receipt: TaskCloseReceipt;
      readonly commandId: string;
    }
  | { readonly status: "orphaned"; readonly reason: OrphanReason };

export type ResolutionAuthority =
  | { readonly kind: "attempt"; readonly owner: "program" | "effect"; readonly audience: string }
  | { readonly kind: "participant"; readonly audience: string; readonly capability: string }
  | {
      readonly kind: "clock";
      readonly audience: string;
      readonly notBefore: string;
      readonly capability: string;
    }
  | {
      readonly kind: "child";
      readonly mode: "invoke" | "all" | "race" | "spawn" | "join";
      readonly audience: string;
      readonly capability: string;
    };

export interface AttemptState {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly capability: string;
  readonly status: "started" | "detached" | "completed" | "revoked" | "superseded";
}

export type PullResolution =
  | { readonly status: "open"; readonly revoked: boolean }
  | {
      readonly status: "settled";
      readonly revoked: boolean;
      readonly settlement: {
        readonly outcome: OperationOutcome;
        readonly outcomeDigest: string;
        readonly receipt: ResolutionReceipt;
      };
    };

export interface PullState {
  readonly pullId: string;
  readonly request: {
    readonly proposedDescriptorDigest: string;
    /** Original proposed value retained for replay comparison and guarded reads. */
    readonly proposedDescriptor: DurableOperationDescriptor;
    readonly acceptedDescriptor: DurableOperationDescriptor;
    readonly resultDescriptor: PortableSchemaDescriptor;
    readonly resultSchemaDigest: string;
    readonly maxOutcomeBytes: number;
    readonly publicMessageId?: string;
  };
  readonly resolutionAuthority: ResolutionAuthority;
  readonly attempts: readonly AttemptState[];
  readonly acceptedFacts: {
    readonly preparation?: ModelContextPreparedFact;
    readonly preparationDigest?: string;
    readonly assistantPartial?: AssistantPartialAcceptedFact;
    readonly assistantPartialDigest?: string;
  };
  readonly resolution: PullResolution;
}

export type ActionState =
  | {
      readonly kind: "pull";
      readonly actionIndex: number;
      readonly pullIndex: number;
      readonly pull: PullState;
    }
  | {
      readonly kind: "emission";
      readonly actionIndex: number;
      readonly emissionIndex: number;
      readonly descriptorDigest: string;
      readonly receipt: EmissionReceipt;
    };

export interface TaskState {
  readonly taskId: string;
  readonly turnId: string;
  readonly origin: TaskOrigin;
  /** Resolved expiry cap inherited by descendant fork groups (REQ-030). */
  readonly deadlineMs?: number;
  /** At most one open fork group per task; the task is frozen while the
   *  group is nonterminal (REQ-021). */
  readonly forkGroup?: ForkGroupState;
  readonly program: {
    readonly artifact: PinnedProgram;
    readonly manifest: DurableProgramManifest;
    readonly input: Json;
  };
  readonly execution: {
    readonly checkpoint?: Extract<ProgramRecoveryCheckpoint, { kind: "continuation" }>;
    readonly epoch: number;
    readonly attachmentId: string;
    readonly audience: string;
    readonly elicitAudience?: string;
    readonly route?: ProgramRoute;
    readonly catalog?: Json;
    readonly catalogDigest?: string;
    /** Materialized task-scoped live lease. The Mandate itself is runtime-only. */
    readonly liveLease?: {
      readonly ownerId: string;
      readonly epoch: number;
      readonly expiresAtMs: number;
      readonly attachmentId: string;
      readonly strandHeadDigest: string;
      readonly forkGroupRevision: number;
      readonly frontierDigest: string;
    };
  };
  readonly actions: readonly ActionState[];
  readonly nextActionIndex: number;
  readonly nextPullIndex: number;
  readonly nextEmissionIndex: number;
  readonly emissionPolicy?: SemanticEmissionPolicy;
  readonly acceptedEmissionCount: number;
  readonly cumulativeEmissionBytes: number;
  readonly lifecycle: TaskLifecycle;
}

export interface AuthoritySessionState {
  readonly execution: { readonly tasks: ReadonlyMap<string, TaskState> };
  readonly control: {
    /** Persisted freshness identity; null until the first semantic append. */
    readonly journalHeadId: string | null;
    readonly runnable: boolean;
    readonly revision: number;
    /** Protocol-owned root address ordinal; task-id text is never parsed. */
    readonly nextRootOrdinal?: number;
    readonly documents?: WorkflowDocumentState;
    readonly activationLease?: ActivationLeaseState;
    readonly lastActivationEpoch: number;
    readonly restoreNonce?: string;
    readonly restoreFrontierDigest?: string;
    readonly consecutiveRestoreStales: number;
    readonly activationNotBeforeMs?: number;
  };
}

export interface AuthorityState {
  readonly sessions: ReadonlyMap<string, AuthoritySessionState>;
  readonly nextNonce: number;
}

/** The sole direct pre-release authority snapshot format. */
export interface DurableAuthoritySnapshot {
  version: 1;
  sessions: Array<
    [
      string,
      {
        execution: { tasks: TaskState[] };
        control: AuthoritySessionState["control"];
      },
    ]
  >;
  nextNonce: number;
  records: Array<[string, DurableSemanticRecord[]]>;
}

export interface JournalAppendCursor {
  readonly sessionId: string;
  readonly nextOffset: number;
}

export interface KernelContext {
  readonly nowMs: number;
  readonly journalIdentity: { readonly id: string; readonly incarnation: string };
  readonly appendCursor: JournalAppendCursor;
  /** Current persisted semantic-head identity bound into restore tickets and proofs. */
  readonly journalHeadId: string;
  readonly keyring: CapabilityKeyring;
  readonly schemas: DurableSchemaRegistry;
  readonly maxOutcomeBytes?: number;
  readonly emissionPolicy?: SemanticEmissionPolicy;
  /** Optional process-local observation used only by cancellation routing. */
  readonly liveEffectTargets?: readonly { readonly taskId: string; readonly pullId: string }[];
  /** Private pipeline diagnostics; never persisted or exposed to callers. */
  readonly decisionDiagnostics?: (diagnostic: DecisionStageDiagnostic) => void;
}

export interface AuthorityDecisionFrame<C extends AuthorityCommand> {
  readonly state: AuthorityState;
  readonly context: KernelContext;
  readonly command: C;
}

export interface KernelTransition<C extends AuthorityCommand> {
  readonly kind: "changed" | "unchanged";
  readonly state: AuthorityState;
  readonly entries: readonly DurableSemanticRecord[];
  readonly result: CommandResult<C>;
}

/** Automatic cleanup carries only the failed activation's original ownership. */
export interface OrphanFence {
  readonly address: ReplayItem["address"];
  readonly program: ReplayItem["program"];
  readonly executionEpoch: number;
  readonly forkGroupRevision: number;
}

export class AcceptedExtensionUnavailable extends CrankError {
  readonly tag = "accepted-extension-unavailable";
  constructor() {
    super("replay_diverged", "Settled strand was not replayable");
  }
}
