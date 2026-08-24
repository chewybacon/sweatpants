/** Durable program authoring contracts. */
import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { EffectDefinition, RetrySafety } from "@sweatpants/durable-effects";
import type {
  DurableProgramManifest,
  GeneratedProgramArtifactIdentityV1,
  ProgramIdentityProvenanceV1,
} from "./program-contract.ts";

export interface RecordAttemptContext {
  readonly pullId: string;
  readonly attemptId: string;
  readonly cancellation: AbortSignal;
}
export interface RecordOptions {
  readonly key: string;
  readonly retrySafety?: RetrySafety;
}

export interface DurableProgramContext {
  /**
   * Single generic parked-pull boundary: lowers any registered interaction
   * descriptor onto the runtime. The only interaction member programs see —
   * ergonomics live in authoring layers, never here (REQ-009).
   */
  pull(descriptor: Json): Operation<Json>;
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
  emit(eventType: string, payload: Json): Operation<void>;
}

export type DurableProgramFactory<I extends Json = Json, O extends Json = Json> = (
  input: I,
  context: DurableProgramContext,
) => Operation<O>;
export interface DurableTool<I extends Json = Json, O extends Json = Json> {
  readonly durability: "crank_native";
  readonly manifest: DurableProgramManifest<I, O>;
  program(input: I, context: DurableProgramContext): Operation<O>;
  readonly identityProvenance: ProgramIdentityProvenanceV1;
  readonly identityArtifact?: GeneratedProgramArtifactIdentityV1;
}
