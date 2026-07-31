/** Durable program authoring contracts. */
import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { EffectDefinition, RetrySafety, OperationOutcome } from "@sweatpants/durable-effects";
import type {
  DurableChildDescriptor,
  DurableOperationDescriptor,
  DurableProgramManifest,
  DurableTaskHandle,
  EmissionDescriptor,
  ForeignToolRequest,
  GeneratedProgramArtifactIdentityV1,
  ProgramIdentityProvenanceV1,
  ProgramElicitResult,
} from "./program-contract.ts";

export type ProgramResume = OperationOutcome | undefined;
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
  readonly key: string;
  readonly retrySafety?: RetrySafety;
}

export interface DurableProgramContext {
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
  record<T extends Json>(
    options: RecordOptions,
    operation: (context: RecordAttemptContext) => Operation<T>,
  ): Operation<T>;
  elicit<T extends Json = Json>(
    key: string,
    message: string,
    response: PortableSchemaDescriptor,
    context?: Json,
  ): Operation<ProgramElicitResult<T>>;
  emit(eventType: string, payload: Json): Operation<void>;
  clock: {
    waitUntil(instant: string, key?: string): Operation<void>;
    sleep(durationMs: number, key?: string): Operation<void>;
  };
  invoke<T extends Json = Json>(child: DurableChildDescriptor): Operation<T>;
  all<T extends readonly Json[] = readonly Json[]>(
    children: DurableChildDescriptor[],
  ): Operation<T>;
  race<T extends Json = Json>(children: DurableChildDescriptor[]): Operation<T>;
  spawn(child: DurableChildDescriptor): Operation<DurableTaskHandle>;
  join<T extends Json = Json>(handle: DurableTaskHandle): Operation<T>;
  foreignTool<T extends Json = Json>(request: ForeignToolRequest): Operation<T>;
}

export type DurableProgramFactory<I extends Json = Json, O extends Json = Json> = (
  input: I,
  context: DurableProgramContext,
) => Operation<O>;
export interface DurableTool<I extends Json = Json, O extends Json = Json> {
  readonly durability: "crank_native";
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableProgramFactory<I, O>;
  readonly identityProvenance: ProgramIdentityProvenanceV1;
  readonly identityArtifact?: GeneratedProgramArtifactIdentityV1;
}
