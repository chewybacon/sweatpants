import type { Operation } from "effection";

import type { Json, SerializedApplicationError } from "./types.ts";

export type JsonSchema = Json;

export type RetrySafety =
  | { mode: "unsafe"; onIndeterminate: "await_decision" | "fail" }
  | { mode: "idempotent"; mechanism: "pull_id_key" | "inherent" };

declare const effectInputType: unique symbol;
declare const effectOutputType: unique symbol;

export interface EffectDefinition<I extends Json = Json, O extends Json = Json> {
  /** Compile-time-only carriers used to infer handler input/output types. */
  readonly [effectInputType]?: I;
  readonly [effectOutputType]?: O;
  name: string;
  version: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  retrySafety: RetrySafety;
}

declare const programInputType: unique symbol;
declare const programOutputType: unique symbol;

export interface DurableProgramManifest<I extends Json = Json, O extends Json = Json> {
  /** Compile-time-only carriers for createDurableTool input/output inference. */
  readonly [programInputType]?: I;
  readonly [programOutputType]?: O;
  programId: string;
  version: string;
  digest: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  elicits: Record<
    string,
    {
      responseSchema: JsonSchema;
      contextSchema?: JsonSchema;
    }
  >;
  effects: Record<string, EffectDefinition>;
  capabilities: {
    durableEmissions: boolean;
    structuredChildren: boolean;
    replay: "strict";
  };
}

export interface EffectDescriptor {
  kind: "effect";
  name: string;
  version: string;
  input: Json;
  resolver: { audience: string; route?: string };
}

export interface DurableElicitDescriptor {
  kind: "elicit";
  key: string;
  message: string;
  responseSchema: JsonSchema;
  context?: Json;
}

export interface WaitDescriptor {
  kind: "wait";
  key: string;
  notBefore?: string;
  durationMs?: number;
}

export interface PinnedProgram {
  id: string;
  version: string;
  digest: string;
}

export interface DurableChildDescriptor extends PinnedProgram {
  input: Json;
}

export interface DurableInvokeDescriptor {
  kind: "invoke";
  child: DurableChildDescriptor;
}

export interface DurableAllDescriptor {
  kind: "all";
  children: DurableChildDescriptor[];
}

export interface DurableRaceDescriptor {
  kind: "race";
  children: DurableChildDescriptor[];
}

export interface DurableSpawnDescriptor {
  kind: "spawn";
  child: DurableChildDescriptor;
}

export interface DurableTaskHandle {
  __durableTask: string;
  owner: string;
}

export type ForeignDurability =
  | "opaque"
  | "ephemeral_handle"
  | "resumable_handle"
  | "server_task"
  | "crank_native";

export type ForeignToolRequest = {
  driver: string;
  tool: string;
  input: Json;
  durability: ForeignDurability;
  route?: string;
};

export type ForeignContinuation = {
  driver: string;
  state: Json;
};

export type ForeignInputRequest =
  | { kind: "sample"; payload: Json }
  | {
      kind: "elicit";
      key: string;
      message: string;
      responseSchema: JsonSchema;
      context?: Json;
    };

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

export type ForeignToolContinueRequest = {
  continuation: ForeignContinuation;
  response: { kind: "sample" | "elicit"; value: Json };
};

export interface DurableJoinDescriptor {
  kind: "join";
  handle: DurableTaskHandle;
}

export type DurableOperationDescriptor =
  | EffectDescriptor
  | DurableElicitDescriptor
  | WaitDescriptor
  | DurableInvokeDescriptor
  | DurableAllDescriptor
  | DurableRaceDescriptor
  | DurableSpawnDescriptor
  | DurableJoinDescriptor;

export interface EmissionDescriptor {
  eventType: string;
  payload: Json;
}

export type OperationOutcome =
  | { status: "ok"; value: Json }
  | { status: "error"; error: SerializedApplicationError }
  | { status: "cancelled" };

export interface ResolutionReceipt {
  sessionId: string;
  taskId: string;
  pullId: string;
  resolutionOffset: string;
  outcomeDigest: string;
  status: "accepted" | "duplicate";
}

export type ProgramRoute = Json;

export interface AttachProgramRequest {
  sessionId: string;
  taskId: string;
  program: PinnedProgram;
  input: Json;
  route: ProgramRoute;
  executionEpoch: number;
}

export interface ProgramAttachment {
  attachmentId: string;
  taskId: string;
  driverKind: "generator" | "worker" | "agentcore" | "mcp" | (string & {});
  route: ProgramRoute;
  executionEpoch: number;
  /** Runtime-only and deliberately excluded from durable JSON. */
  handle: unknown;
}

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

export type ProgramStep =
  | { type: "operation"; actionIndex: number; descriptor: DurableOperationDescriptor }
  | { type: "emission"; actionIndex: number; descriptor: EmissionDescriptor }
  | { type: "completed"; actionIndex: number; value: Json }
  | { type: "failed"; actionIndex: number; error: SerializedApplicationError };

export type ProgramShutdownReason =
  | "parked"
  | "completed"
  | "failed"
  | "cancelled"
  | "transport_lost"
  | "scope_exit";

export interface ProgramDriver {
  attach(request: AttachProgramRequest): Operation<ProgramAttachment>;
  step(attachment: ProgramAttachment, command: ProgramCommand): Operation<ProgramStep>;
  shutdown(attachment: ProgramAttachment, reason: ProgramShutdownReason): Operation<void>;
  manifest?(program: PinnedProgram): Operation<DurableProgramManifest>;
}

export type ProgramResume = OperationOutcome | undefined;

export type DurableProgramGenerator<O extends Json = Json> = Generator<
  ProgramStepProposal,
  O,
  ProgramResume
>;

export type ProgramStepProposal =
  | { type: "operation"; descriptor: DurableOperationDescriptor }
  | { type: "emission"; descriptor: EmissionDescriptor };

export interface DurableProgramContext {
  effect<I extends Json, O extends Json>(
    definition: EffectDefinition<I, O>,
    input: I,
    resolver: { audience: string; route?: string },
  ): Generator<ProgramStepProposal, O, ProgramResume>;
  effect<T extends Json = Json>(
    name: string,
    version: string,
    input: Json,
    resolver: { audience: string; route?: string },
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  elicit<T extends Json = Json>(
    key: string,
    message: string,
    responseSchema: JsonSchema,
    context?: Json,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  emit(eventType: string, payload: Json): Generator<ProgramStepProposal, void, ProgramResume>;
  clock: {
    waitUntil(instant: string, key?: string): Generator<ProgramStepProposal, void, ProgramResume>;
    sleep(durationMs: number, key?: string): Generator<ProgramStepProposal, void, ProgramResume>;
  };
  invoke<T extends Json = Json>(
    child: DurableChildDescriptor,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  all<T extends readonly Json[] = readonly Json[]>(
    children: DurableChildDescriptor[],
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  race<T extends Json = Json>(
    children: DurableChildDescriptor[],
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  spawn(
    child: DurableChildDescriptor,
  ): Generator<ProgramStepProposal, DurableTaskHandle, ProgramResume>;
  join<T extends Json = Json>(
    handle: DurableTaskHandle,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
  foreignTool<T extends Json = Json>(
    request: ForeignToolRequest,
  ): Generator<ProgramStepProposal, T, ProgramResume>;
}

export type DurableProgramFactory<I extends Json = Json, O extends Json = Json> = (
  input: I,
  context: DurableProgramContext,
) => DurableProgramGenerator<O>;

export interface DurableTool<I extends Json = Json, O extends Json = Json> {
  readonly durability: "crank_native";
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableProgramFactory<I, O>;
}

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

export type CapabilityClaims = ProgramExecutionCapabilityClaims | ResolutionCapabilityClaims;

export interface ReserveOperationRequest {
  sessionId: string;
  turnId: string;
  taskId: string;
  actionIndex: number;
  pullIndex: number;
  descriptor: DurableOperationDescriptor;
  programCapability: string;
}

export type ReserveOperationResult =
  | { status: "resolved"; outcome: OperationOutcome; receipt: ResolutionReceipt }
  | {
      status: "authorized";
      pullId: string;
      attemptId: string;
      resolutionCapability: string;
      notBefore?: string;
    }
  | {
      status: "pending";
      pullId: string;
      reason: "elicit" | "wait" | "child" | "indeterminate";
      resolutionCapability?: string;
    };

export interface ResolveOperationRequest {
  capability: string;
  audience: string;
  outcome: OperationOutcome;
}

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
        | "wait_not_due";
    };

export interface AppendEmissionRequest {
  sessionId: string;
  taskId: string;
  actionIndex: number;
  descriptor: EmissionDescriptor;
  programCapability: string;
}

export interface EmissionReceipt {
  offset: string;
  eventId: string;
  duplicate: boolean;
}

export interface CompleteTaskRequest {
  sessionId: string;
  taskId: string;
  actionIndex: number;
  outcome: OperationOutcome;
  programCapability: string;
}

export interface TaskCloseReceipt {
  offset: string;
  duplicate: boolean;
}

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

export interface EnsureChildTaskResult {
  taskId: string;
  outcome?: OperationOutcome;
}

export interface DurableJournalAuthorityService {
  bindProgramAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
    executionEpoch: number,
  ): Operation<{ programCapability: string }>;
  ensureChildTask(request: EnsureChildTaskRequest): Operation<EnsureChildTaskResult>;
  reserve(request: ReserveOperationRequest): Operation<ReserveOperationResult>;
  resolve(request: ResolveOperationRequest): Operation<ResolveOperationResult>;
  emit(request: AppendEmissionRequest): Operation<EmissionReceipt>;
  complete(request: CompleteTaskRequest): Operation<TaskCloseReceipt>;
}

export interface DurableEffectAuthorization {
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  descriptor: EffectDescriptor;
  resolutionCapability: string;
  resolver: { audience: string; route?: string };
}

export interface DurableEffectContext {
  sessionId: string;
  taskId: string;
  pullId: string;
  attemptId: string;
  cancellation: AbortSignal;
  resolver: { audience: string; route?: string };
}

export type DurableEffectHandler = (input: Json, context: DurableEffectContext) => Operation<Json>;

export interface DurableEffectRegistration {
  definition: EffectDefinition;
  handler: DurableEffectHandler;
  satisfies: { mode: "unsafe" } | { mode: "idempotent"; mechanism: "pull_id_key" | "inherent" };
}

export type DurableEffectRegistry = ReadonlyMap<string, DurableEffectRegistration>;

export interface ProgramRunRequest {
  attach: AttachProgramRequest;
  programCapability?: string;
  executeHostEffects?: boolean;
}

export type ProgramRunResult =
  | { state: "completed"; value: Json }
  | { state: "failed"; error: SerializedApplicationError }
  | { state: "parked"; pullId: string; reason: string };
