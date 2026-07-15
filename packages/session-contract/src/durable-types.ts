import type { Operation } from "effection";

import type { PortableSchemaDescriptor } from "./schema-descriptor.ts";
import type { Json, SerializedApplicationError } from "./types.ts";

/** Portable JSON Schema projection carried on wire/browser transports. */
export type JsonSchema = Json;

/** Retry policy declaring whether duplicate host execution is safe. */
export type RetrySafety =
  | { mode: "unsafe"; onIndeterminate: "await_decision" | "fail" }
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
  /** Compile-time-only carriers for createDurableTool input/output inference. */
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

/** Exhaustive journaled operation descriptor algebra. */
export type DurableOperationDescriptor =
  | EffectDescriptor
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
      reason: "program_version_unavailable" | "program_corrupt" | "cleanup_stuck";
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
}

/** Runtime-only attachment; its handle MUST NOT enter durable JSON. */
export interface ProgramAttachment {
  attachmentId: string;
  taskId: string;
  driverKind: "generator" | "worker" | "agentcore" | "mcp" | (string & {});
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
    }
  | { type: "ack_emission"; actionIndex: number; offset: string }
  | { type: "cancel"; reason?: string };

/** Exhaustive observable step returned by a program driver. */
export type ProgramStep =
  | { type: "operation"; actionIndex: number; descriptor: DurableOperationDescriptor }
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

/** Scoped adapter port for attaching, stepping, and shutting down one program artifact. */
export interface ProgramDriver {
  /** Acquires an attachment owned by the caller's Effection scope. */
  attach(request: AttachProgramRequest): Operation<ProgramAttachment>;
  /** Applies one ordered command and returns exactly one program step. */
  step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep>;
  /** Releases attachment resources on every terminal or scope-exit path. */
  shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void>;
  /** Resolves an exact pinned manifest when the driver owns artifact lookup. */
  manifest?(program: PinnedProgram): Operation<DurableProgramManifest>;
}

/** Resume value injected into a durable generator after a recorded operation. */
export type ProgramResume = OperationOutcome | undefined;

/** Synchronous generator whose only effects are durable proposals. */
export type DurableProgramGenerator<O extends Json = Json> = Generator<
  ProgramStepProposal,
  O,
  ProgramResume
>;

/** Closed set of proposals an authored durable generator may yield. */
export type ProgramStepProposal =
  | { type: "operation"; descriptor: DurableOperationDescriptor }
  | { type: "emission"; descriptor: EmissionDescriptor };

/** Authoring API that constructs only declared, serializable durable proposals. */
export interface DurableProgramContext {
  /** Proposes a declared host effect and returns its schema-parsed recorded result. */
  effect<I extends Json, O extends Json, P extends Json = never>(
    definition: EffectDefinition<I, O, P>,
    input: I,
    resolver: { audience: string; route?: string },
  ): Generator<ProgramStepProposal, O, ProgramResume>;
  effect<T extends Json = Json>(
    name: string,
    version: string,
    input: Json,
    resolver: { audience: string; route?: string },
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  /** Proposes user input; accepted content must satisfy the descriptor's registered validator. */
  elicit<T extends Json = Json>(
    key: string,
    message: string,
    response: PortableSchemaDescriptor,
    context?: Json,
  ): Generator<ProgramStepProposal, WireElicitResultJson<T>, ProgramResume>;
  /** Proposes an ordered, durable public emission. */
  emit(eventType: string, payload: Json): Generator<ProgramStepProposal, void, ProgramResume>;
  /** Deterministic scheduler operations; relative sleeps become persisted absolute deadlines. */
  clock: {
    /** Waits until a valid absolute instant. */
    waitUntil(instant: string, key?: string): Generator<ProgramStepProposal, void, ProgramResume>;
    /** Sleeps for a nonnegative duration recorded once by the authority. */
    sleep(durationMs: number, key?: string): Generator<ProgramStepProposal, void, ProgramResume>;
  };
  /** Invokes and joins one deterministic child task. */
  invoke<T extends Json = Json>(
    child: DurableChildDescriptor,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  /** Invokes children and returns their ordered results after all close. */
  all<T extends readonly Json[] = readonly Json[]>(
    children: DurableChildDescriptor[],
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  /** Invokes children and returns the authority-recorded winner. */
  race<T extends Json = Json>(
    children: DurableChildDescriptor[],
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  /** Spawns an owned child and returns an owner-bound handle. */
  spawn(
    child: DurableChildDescriptor,
  ): Generator<ProgramStepProposal, DurableTaskHandle, ProgramResume>;
  /** Joins a child handle owned by this program. */
  join<T extends Json = Json>(
    handle: DurableTaskHandle,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  /** Invokes a compatibility driver without upgrading its declared durability. */
  foreignTool<T extends Json = Json>(
    request: ForeignToolRequest,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
}

/** Pure synchronous factory for one durable program generator. */
export type DurableProgramFactory<I extends Json = Json, O extends Json = Json> = (
  input: I,
  context: DurableProgramContext,
) => DurableProgramGenerator<O>;

/** Crank-native tool pairing a pinned manifest with its synchronous program. */
export interface DurableTool<I extends Json = Json, O extends Json = Json> {
  readonly durability: "crank_native";
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableProgramFactory<I, O>;
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
}

/** Reserve result distinguishing replay, host authorization, and durable parking. */
export type ReserveOperationResult =
  | { status: "resolved"; outcome: OperationOutcome; receipt: ResolutionReceipt }
  | {
      status: "authorized";
      pullId: string;
      attemptId: string;
      /** Canonical parsed effect descriptor accepted by the authority. */
      descriptor: EffectDescriptor;
      resolutionCapability: string;
      notBefore?: string;
    }
  | {
      status: "pending";
      pullId: string;
      reason: "elicit" | "wait" | "child" | "indeterminate";
      resolutionCapability?: string;
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
}

/** Stable receipt identifying an appended or duplicate emission. */
export interface EmissionReceipt {
  offset: string;
  eventId: string;
  duplicate: boolean;
}

/** Program-authorized request to close a task with a schema-valid outcome. */
export interface CompleteTaskRequest {
  sessionId: string;
  taskId: string;
  actionIndex: number;
  outcome: OperationOutcome;
  programCapability: string;
}

/** Stable receipt identifying task closure or idempotent replay. */
export interface TaskCloseReceipt {
  offset: string;
  duplicate: boolean;
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
}

/** Child allocation result, including an already-recorded terminal outcome when present. */
export interface EnsureChildTaskResult {
  taskId: string;
  outcome?: OperationOutcome;
}

/** Narrow authority port mediating every durable state transition. */
export interface DurableJournalAuthorityService {
  /** Returns the canonical parsed input accepted for a task; replay never reruns schema code. */
  taskInput(sessionId: string, taskId: string): Operation<Json>;
  /** Lists exact schema digests referenced by nonterminal durable tasks for readiness/retirement. */
  nonterminalSchemaDigests(): Operation<string[]>;
  /** Clears the runnable marker when a structured activation starts. */
  markActivated(sessionId: string): Operation<void>;
  /** Reads the durable cancellation state used by fresh replay attachments. */
  cancellationState(sessionId: string, taskId: string): Operation<DurableCancellationState>;
  /** Transitions a settled cancellation frontier into one-shot unwind. */
  beginCancellationUnwind(sessionId: string, taskId: string): Operation<DurableCancellationState>;
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
}

/** Host dispatch authorization with attempt identity and resolution capability. */
export interface DurableEffectAuthorization {
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  descriptor: EffectDescriptor;
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
  satisfies: { mode: "unsafe" } | { mode: "idempotent"; mechanism: "pull_id_key" | "inherent" };
}

/** Immutable symbolic effect registry installed at composition. */
export type DurableEffectRegistry = ReadonlyMap<string, DurableEffectRegistration>;

/** Runtime request controlling attachment and optional in-scope host dispatch. */
export interface ProgramRunRequest {
  attach: AttachProgramRequest;
  programCapability?: string;
  executeHostEffects?: boolean;
}

/** Caller-visible terminal or parked result of one runtime activation. */
export type ProgramRunResult =
  | { state: "completed"; value: Json }
  | { state: "failed"; error: SerializedApplicationError }
  | { state: "cancelled" }
  | { state: "parked"; pullId: string; reason: string };
