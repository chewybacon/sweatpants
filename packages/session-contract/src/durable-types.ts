import type { Operation } from "effection";

import type { PortableSchemaDescriptor } from "./schema-descriptor.ts";
import type {
  GeneratedProgramArtifactIdentityV1,
  ProgramIdentityProvenanceV1,
} from "./program-identity.ts";
import type { Json, SerializedApplicationError } from "./types.ts";

/** Portable JSON Schema projection carried on wire/browser transports. */
export type JsonSchema = Json;

/** Retry policy declaring whether duplicate host execution is safe. */
export type RetrySafety =
  | { mode: "repeatable" }
  | { mode: "unsafe" }
  | { mode: "idempotent"; mechanism: "pull_id_key" | "inherent" };

declare const effectInputType: unique symbol;
declare const effectOutputType: unique symbol;
declare const effectCancellationPartialType: unique symbol;

/** Versioned effect contract carrying runtime schemas and compile-time witnesses. */
export interface EffectDefinition<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
> {
  /** Compile-time-only carriers used to infer handler input/output/partial types. */
  readonly [effectInputType]?: I;
  readonly [effectOutputType]?: O;
  readonly [effectCancellationPartialType]?: P;
  name: string;
  version: string;
  inputSchema: PortableSchemaDescriptor;
  outputSchema: PortableSchemaDescriptor;
  cancellation?: { partialSchema: PortableSchemaDescriptor };
  retrySafety: RetrySafety;
}

/** Closed terminal report returned by every durable effect handler. */
export type DurableEffectDisposition<O extends Json, P extends Json = never> =
  | { status: "ok"; value: O }
  | { status: "error"; error: SerializedApplicationError }
  | ([P] extends [never]
      ? { status: "cancelled"; partial?: never }
      : { status: "cancelled"; partial?: P });

declare const programInputType: unique symbol;
declare const programOutputType: unique symbol;

/** Pinned program contract defining schemas, declared operations, and replay capabilities. */
export interface DurableProgramManifest<I extends Json = Json, O extends Json = Json> {
  /** Compile-time-only carriers for createPinnedDurableProgram input/output inference. */
  readonly [programInputType]?: I;
  readonly [programOutputType]?: O;
  programId: string;
  version: string;
  digest: string;
  inputSchema: PortableSchemaDescriptor;
  outputSchema: PortableSchemaDescriptor;
  elicits: Record<
    string,
    {
      /** Accepted-content schema descriptor; never the wire action envelope. */
      response: PortableSchemaDescriptor;
      context?: PortableSchemaDescriptor;
    }
  >;
  effects: Record<string, EffectDefinition<Json, Json, Json>>;
  capabilities: {
    durableEmissions: boolean;
    structuredChildren: boolean;
    replay: "strict";
  };
}

/** Journaled host-effect request bound to an explicit resolver audience. */
export interface EffectDescriptor {
  kind: "effect";
  name: string;
  version: string;
  input: Json;
  resolver: { audience: string; route?: string };
}

/** Journaled user-input request with a persisted content-schema descriptor. */
export interface DurableElicitDescriptor {
  kind: "elicit";
  key: string;
  message: string;
  /** Portable descriptor for the accepted content; not the action envelope. */
  response: PortableSchemaDescriptor;
  /** Canonical authored context only; correlation metadata stays private. */
  context?: Json;
}

/** Journaled absolute or relative scheduler wait; exactly one deadline form is legal. */
export interface WaitDescriptor {
  kind: "wait";
  key: string;
  notBefore?: string;
  durationMs?: number;
}

/** Immutable program artifact identity required for deterministic recovery. */
export interface PinnedProgram {
  id: string;
  version: string;
  digest: string;
}

/** Trusted sandbox scope. V1 placement installs invocation affinity only. */
export type SandboxAffinity =
  | { readonly kind: "invocation"; readonly key: string }
  | { readonly kind: "conversation"; readonly key: string }
  | { readonly kind: "workspace"; readonly key: string };

/** Immutable AgentCore release metadata retained for exact task replay. */
export interface AgentCoreRuntimeRelease {
  readonly releaseId: string;
  readonly runtimeArn: string;
  readonly region: string;
  readonly imageDigest: string;
  readonly protocolVersion: 1;
  readonly registryDigest: string;
  readonly iamProfile: string;
  readonly networkProfile: string;
  readonly filesystem: {
    readonly kind: "managed_session_storage";
    readonly mountPath: string;
  };
  readonly lifecycle: {
    readonly idleRuntimeSessionTimeoutSeconds: number;
    readonly maxLifetimeSeconds: number;
  };
}

/** Private task placement. None of these fields belong in semantic descriptors. */
export interface AgentCoreTaskPlacement {
  readonly journalId: string;
  readonly taskId: string;
  readonly affinity: SandboxAffinity;
  readonly runtimeSessionId: string;
  readonly release: AgentCoreRuntimeRelease;
  readonly program: PinnedProgram;
  readonly createdAt: string;
  readonly terminalAt?: string;
  readonly lastComputeGeneration?: string;
}

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

/** Trusted context used by the authority to derive a nonce-hiding replay chain. */
export interface ProgramRestoreContext {
  readonly replayDomain: string;
  readonly frontierDomain: string;
  readonly releaseId: string;
  readonly sandboxSessionId: string;
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

/** Pinned child invocation and canonical input. */
export interface DurableChildDescriptor extends PinnedProgram {
  input: Json;
}

/** Structured, joined child invocation descriptor. */
export interface DurableInvokeDescriptor {
  kind: "invoke";
  child: DurableChildDescriptor;
}

/** Structured descriptor joining all children in declaration order. */
export interface DurableAllDescriptor {
  kind: "all";
  children: DurableChildDescriptor[];
}

/** Structured descriptor selecting one durably recorded child winner. */
export interface DurableRaceDescriptor {
  kind: "race";
  children: DurableChildDescriptor[];
}

/** Structured descriptor spawning an owned child task. */
export interface DurableSpawnDescriptor {
  kind: "spawn";
  child: DurableChildDescriptor;
}

/** Opaque task handle whose owner prevents cross-program joins. */
export interface DurableTaskHandle {
  __durableTask: string;
  owner: string;
}

/** Effective durability classification at a foreign execution boundary. */
export type ForeignDurability =
  | "opaque"
  | "ephemeral_handle"
  | "resumable_handle"
  | "server_task"
  | "crank_native";

/** Serializable request to an explicitly named foreign driver and tool. */
export type ForeignToolRequest = {
  driver: string;
  tool: string;
  input: Json;
  durability: ForeignDurability;
  route?: string;
};

/** Driver-owned canonical continuation state returned to durable orchestration. */
export type ForeignContinuation = {
  driver: string;
  state: Json;
};

/** Canonical wire action envelope for one elicitation resolution. */
export type WireElicitResultJson<T extends Json = Json> =
  | { action: "accept"; content: T }
  | { action: "decline"; reason?: string }
  | { action: "cancel"; reason?: string };

/** Closed foreign backchannel request algebra. */
export type ForeignInputRequest =
  | { kind: "sample"; payload: Json }
  | {
      kind: "elicit";
      key: string;
      message: string;
      responseSchema: JsonSchema;
      context?: Json;
    };

/** Closed foreign execution result algebra; expected failures remain values. */
export type ForeignToolDisposition =
  | { type: "input_required"; request: ForeignInputRequest; continuation: ForeignContinuation }
  | { type: "completed"; result: Json }
  | {
      type: "failed";
      error: {
        code: string;
        message: string;
        durability: ForeignDurability;
        retryable: boolean;
      };
    };

/** Serializable response applied to a previously returned foreign continuation. */
export type ForeignToolContinueRequest = {
  continuation: ForeignContinuation;
  response: { kind: "sample" | "elicit" | "cancel"; value: Json };
};

/** Descriptor joining a previously spawned owned task. */
export interface DurableJoinDescriptor {
  kind: "join";
  handle: DurableTaskHandle;
}

/** Execution-owned operation whose implementation remains with the program attachment. */
export interface RecordedOperationDescriptor {
  kind: "record";
  label?: string;
  retrySafety: RetrySafety;
}

/** Exhaustive journaled operation descriptor algebra. */
export type DurableOperationDescriptor =
  | EffectDescriptor
  | RecordedOperationDescriptor
  | DurableElicitDescriptor
  | WaitDescriptor
  | DurableInvokeDescriptor
  | DurableAllDescriptor
  | DurableRaceDescriptor
  | DurableSpawnDescriptor
  | DurableJoinDescriptor;

/** Canonical public emission proposed by a durable program. */
export interface EmissionDescriptor {
  eventType: string;
  payload: Json;
}

/** Exhaustive persisted outcome algebra for pulls and tasks. */
export type OperationOutcome =
  | { status: "ok"; value: Json }
  | { status: "error"; error: SerializedApplicationError }
  | { status: "cancelled"; partial?: Json };

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

/** Stable receipt proving acceptance or idempotent replay of one resolution. */
export interface ResolutionReceipt {
  sessionId: string;
  taskId: string;
  pullId: string;
  resolutionOffset: string;
  outcomeDigest: string;
  status: "accepted" | "duplicate";
}

/** Driver-owned canonical routing data persisted with attachment requests. */
export type ProgramRoute = Json;

/** Complete request for attaching to a pinned task execution epoch. */
export interface AttachProgramRequest {
  sessionId: string;
  taskId: string;
  program: PinnedProgram;
  input: Json;
  route: ProgramRoute;
  executionEpoch: number;
  /** Deployment-approved opaque affinity projected by a trust-boundary driver. */
  affinity?: SandboxAffinity;
}

/** Runtime-only attachment; its handle MUST NOT enter durable JSON. */
export interface ProgramAttachment {
  attachmentId: string;
  taskId: string;
  driverKind: "program" | "worker" | "agentcore" | "mcp" | (string & {});
  route: ProgramRoute;
  executionEpoch: number;
  /** Runtime-only and deliberately excluded from durable JSON. */
  handle: unknown;
}

/** Commands accepted by a program driver under ordered action indices. */
export type ProgramCommand =
  | { type: "start"; input: Json }
  | {
      type: "resume";
      actionIndex: number;
      outcome: OperationOutcome;
      receipt: ResolutionReceipt;
      replayed: boolean;
    }
  | {
      type: "authorize";
      actionIndex: number;
      pullId: string;
      attemptId: string;
      resolutionCapability: string;
      descriptor?: EffectDescriptor | RecordedOperationDescriptor;
      effectContractDigest?: string;
    }
  | { type: "ack_emission"; actionIndex: number; offset: string }
  | { type: "cancel"; reason?: string };

/** Exhaustive observable step returned by a program driver. */
export type ProgramStep =
  | {
      type: "operation";
      actionIndex: number;
      descriptor: DurableOperationDescriptor;
      /** Transient authorize response; never persisted as a replay frontier. */
      authorizedOutcome?: OperationOutcome;
    }
  | { type: "emission"; actionIndex: number; descriptor: EmissionDescriptor }
  | { type: "completed"; actionIndex: number; value: Json }
  | { type: "failed"; actionIndex: number; error: SerializedApplicationError };

/** Stable reason algebra for releasing a driver attachment. */
export type ProgramShutdownReason =
  | "parked"
  | "completed"
  | "failed"
  | "cancelled"
  | "transport_lost"
  | "scope_exit";

/** One bounded operation entry streamed during fresh-task restoration. */
export interface ReplayOperationEntry {
  readonly type: "operation";
  readonly actionIndex: number;
  readonly descriptorKind: string;
  readonly descriptorDigest: string;
  readonly previousEntryDigest: string;
  readonly entryDigest: string;
  readonly outcome: OperationOutcome;
  readonly receipt: ResolutionReceipt;
}

/** One bounded emission acknowledgement streamed during restoration. */
export interface ReplayEmissionEntry {
  readonly type: "emission";
  readonly actionIndex: number;
  readonly descriptorKind: string;
  readonly descriptorDigest: string;
  readonly previousEntryDigest: string;
  readonly entryDigest: string;
  readonly offset: string;
}

export type ReplayEntry = ReplayOperationEntry | ReplayEmissionEntry;

/** Async-agnostic replay source; implementations may stream without buffering history. */
export interface ProgramReplayStream {
  readonly [Symbol.iterator]?: () => Iterator<ReplayEntry>;
  readonly [Symbol.asyncIterator]?: () => AsyncIterator<ReplayEntry>;
}

export interface ProgramRestoreRequest {
  readonly attach: AttachProgramRequest;
  readonly replay: ProgramReplayStream;
  readonly replayedThroughActionIndex: number;
  readonly replayChainSeed: string;
  readonly replayChainDigest: string;
}

export interface RestoredProgramAttachment {
  readonly attachment: ProgramAttachment;
  readonly frontier: ProgramStep;
  readonly replayedThroughActionIndex: number;
  readonly replayChainDigest: string;
  readonly frontierDigest: string;
  readonly computeGeneration?: string;
}

/** Scoped adapter port for attaching, restoring, stepping, and shutting down one artifact. */
export interface ProgramDriver {
  /** Acquires an attachment owned by the caller's Effection scope. */
  attach(request: AttachProgramRequest): Operation<ProgramAttachment>;
  /** Applies one ordered command and returns exactly one program step. */
  step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep>;
  /** Releases attachment resources on every terminal or scope-exit path. */
  shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void>;
  /** Optional streamed fresh-task replay fast path. */
  restore?(request: ProgramRestoreRequest): Operation<RestoredProgramAttachment>;
  /** Supplies driver-owned serializable identity/digest domains for authority restoration. */
  restoreContext?(request: AttachProgramRequest): Operation<ProgramRestoreContext>;
  /** Resolves an exact pinned manifest when the driver owns artifact lookup. */
  manifest?(program: PinnedProgram): Operation<DurableProgramManifest>;
}

/** Resume value injected into a suspended durable program boundary. */
export type ProgramResume = OperationOutcome | undefined;

/** Closed set of proposals an authored durable program task may publish. */
export type ProgramStepProposal =
  | { type: "operation"; descriptor: DurableOperationDescriptor; execute?: RecordedOperation }
  | { type: "emission"; descriptor: EmissionDescriptor };

export interface RecordAttemptContext {
  readonly pullId: string;
  readonly attemptId: string;
  readonly cancellation: AbortSignal;
}

export type RecordedOperation = (context: RecordAttemptContext) => Operation<Json>;

export interface RecordOptions {
  readonly label?: string;
  readonly retrySafety?: RetrySafety;
}

/** Authoring API that constructs only declared, serializable durable proposals. */
export interface DurableProgramContext {
  /** Proposes a declared host effect and returns its schema-parsed recorded result. */
  effect<I extends Json, O extends Json, P extends Json = never>(
    definition: EffectDefinition<I, O, P>,
    input: I,
    resolver: { audience: string; route?: string },
  ): Operation<O>;
  effect<T extends Json = Json>(
    name: string,
    version: string,
    input: Json,
    resolver: { audience: string; route?: string },
  ): Operation<T>;
  /** Records one execution-owned Effection operation; replay returns the accepted outcome. */
  record<T extends Json>(operation: () => Operation<T>): Operation<T>;
  record<T extends Json>(label: string, operation: () => Operation<T>): Operation<T>;
  record<T extends Json>(
    options: RecordOptions,
    operation: (context: RecordAttemptContext) => Operation<T>,
  ): Operation<T>;
  /** Proposes user input; accepted content must satisfy the descriptor's registered validator. */
  elicit<T extends Json = Json>(
    key: string,
    message: string,
    response: PortableSchemaDescriptor,
    context?: Json,
  ): Operation<WireElicitResultJson<T>>;
  /** Proposes an ordered, durable public emission. */
  emit(eventType: string, payload: Json): Operation<void>;
  /** Deterministic scheduler operations; relative sleeps become persisted absolute deadlines. */
  clock: {
    /** Waits until a valid absolute instant. */
    waitUntil(instant: string, key?: string): Operation<void>;
    /** Sleeps for a nonnegative duration recorded once by the authority. */
    sleep(durationMs: number, key?: string): Operation<void>;
  };
  /** Invokes and joins one deterministic child task. */
  invoke<T extends Json = Json>(child: DurableChildDescriptor): Operation<T>;
  /** Invokes children and returns their ordered results after all close. */
  all<T extends readonly Json[] = readonly Json[]>(
    children: DurableChildDescriptor[],
  ): Operation<T>;
  /** Invokes children and returns the authority-recorded winner. */
  race<T extends Json = Json>(children: DurableChildDescriptor[]): Operation<T>;
  /** Spawns an owned child and returns an owner-bound handle. */
  spawn(child: DurableChildDescriptor): Operation<DurableTaskHandle>;
  /** Joins a child handle owned by this program. */
  join<T extends Json = Json>(handle: DurableTaskHandle): Operation<T>;
  /** Invokes a classified foreign driver without upgrading its declared durability. */
  foreignTool<T extends Json = Json>(request: ForeignToolRequest): Operation<T>;
}

/** Effection-native factory for one durable program operation. */
export type DurableProgramFactory<I extends Json = Json, O extends Json = Json> = (
  input: I,
  context: DurableProgramContext,
) => Operation<O>;

/** Crank-native program pairing a pinned manifest with its Effection implementation. */
export interface DurableTool<I extends Json = Json, O extends Json = Json> {
  readonly durability: "crank_native";
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableProgramFactory<I, O>;
  /** Explicit evidence describing whether the digest was generated or manually asserted. */
  readonly identityProvenance: ProgramIdentityProvenanceV1;
  /** Local verification evidence retained only for generated bindings. */
  readonly identityArtifact?: GeneratedProgramArtifactIdentityV1;
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

/** Host dispatch authorization with attempt identity and resolution capability. */
export interface DurableEffectAuthorization {
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  descriptor: EffectDescriptor;
  /** Authority-derived whole-contract digest for handler compatibility checks. */
  effectContractDigest: string;
  resolutionCapability: string;
  resolver: { audience: string; route?: string };
}

/** Scoped host-effect context carrying stable idempotency IDs and cancellation. */
export interface DurableEffectContext {
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  cancellation: AbortSignal;
  resolver: { audience: string; route?: string };
}

/** Effection-native host-effect handler returning one explicit disposition. */
export type DurableEffectHandler<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
> = (input: I, context: DurableEffectContext) => Operation<DurableEffectDisposition<O, P>>;

/** Effect handler registration proving compatibility with its retry declaration. */
export interface DurableEffectRegistration {
  definition: EffectDefinition<Json, Json, Json>;
  handler: DurableEffectHandler<Json, Json, Json>;
  satisfies:
    | { mode: "repeatable" }
    | { mode: "unsafe" }
    | { mode: "idempotent"; mechanism: "pull_id_key" | "inherent" };
}

/** Immutable symbolic effect registry installed at composition. */
export type DurableEffectRegistry = ReadonlyMap<string, DurableEffectRegistration>;

/** Runtime request controlling attachment and optional in-scope host dispatch. */
export interface ProgramRunRequest {
  attach: AttachProgramRequest;
  programCapability?: string;
  executeHostEffects?: boolean;
  /** Host-private owner used to issue/consume restore tickets under a claimed lease. */
  activationOwnerId?: string;
}

/** Caller-visible terminal or parked result of one runtime activation. */
export type ProgramRunResult =
  | { state: "completed"; value: Json }
  | { state: "failed"; error: SerializedApplicationError }
  | { state: "cancelled" }
  | { state: "parked"; pullId: string; reason: string };
