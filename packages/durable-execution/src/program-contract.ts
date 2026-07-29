/** Durable-execution-owned program contracts. */
import type { Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { EffectDefinition, RetrySafety, OperationOutcome } from "@sweatpants/durable-effects";

export const PROGRAM_ARTIFACT_IDENTITY_FORMAT = "sweatpants.program-artifact-identity.v1" as const;
export const PROGRAM_ARTIFACT_IDENTITY_DOMAIN = `${PROGRAM_ARTIFACT_IDENTITY_FORMAT}\n`;
export const PROGRAM_ARTIFACT_GENERATOR_VERSION = 2;
export const PROGRAM_INTERFACE_IDENTITY_FORMAT =
  "sweatpants.program-interface-identity.v1" as const;
export const PROGRAM_INTERFACE_IDENTITY_DOMAIN = `${PROGRAM_INTERFACE_IDENTITY_FORMAT}\n`;
export const PROGRAM_INTERFACE_GENERATOR_VERSION = 2;

export interface ProgramArtifactIdentityInputV1 {
  readonly format: typeof PROGRAM_ARTIFACT_IDENTITY_FORMAT;
  readonly generatorVersion: number;
  readonly manifest: Omit<DurableProgramManifest, "digest">;
  readonly implementationArtifactDigest: string;
  readonly resourcePackageDigests: readonly string[];
}

export type ProgramIdentityProvenanceV1 =
  | {
      readonly kind: "generated-interface";
      readonly format: typeof PROGRAM_INTERFACE_IDENTITY_FORMAT;
      readonly generatorVersion: number;
      readonly identityInputDigest: string;
    }
  | {
      readonly kind: "generated-artifact";
      readonly format: typeof PROGRAM_ARTIFACT_IDENTITY_FORMAT;
      readonly generatorVersion: number;
      readonly identityInputDigest: string;
    }
  | { readonly kind: "asserted" };

export interface GeneratedProgramInterfaceIdentityV1 {
  readonly digest: string;
  readonly provenance: Extract<ProgramIdentityProvenanceV1, { kind: "generated-interface" }>;
}
export interface GeneratedProgramArtifactIdentityV1 {
  readonly digest: string;
  readonly input: ProgramArtifactIdentityInputV1;
  readonly provenance: Extract<ProgramIdentityProvenanceV1, { kind: "generated-artifact" }>;
}

export type JsonSchema = Json;

export interface DurableProgramManifest<I extends Json = Json, O extends Json = Json> {
  readonly [programInputType]?: I;
  readonly [programOutputType]?: O;
  programId: string;
  version: string;
  digest: string;
  inputSchema: PortableSchemaDescriptor;
  outputSchema: PortableSchemaDescriptor;
  elicits: Record<
    string,
    { response: PortableSchemaDescriptor; context?: PortableSchemaDescriptor }
  >;
  effects: Record<string, EffectDefinition<Json, Json, Json>>;
  capabilities: { durableEmissions: boolean; structuredChildren: boolean; replay: "strict" };
}
const programInputType: unique symbol = Symbol("program-input") as never;
const programOutputType: unique symbol = Symbol("program-output") as never;

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
  response: PortableSchemaDescriptor;
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
export type SandboxAffinity = { kind: "invocation" | "conversation" | "workspace"; key: string };
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
export type ForeignContinuation = { driver: string; state: Json };
export type WireElicitResultJson<T extends Json = Json> =
  | { action: "accept"; content: T }
  | { action: "decline"; reason?: string }
  | { action: "cancel"; reason?: string };
export type ForeignInputRequest =
  | { kind: "sample"; payload: Json }
  | { kind: "elicit"; key: string; message: string; responseSchema: JsonSchema; context?: Json };
export type ForeignToolDisposition =
  | { type: "input_required"; request: ForeignInputRequest; continuation: ForeignContinuation }
  | { type: "completed"; result: Json }
  | {
      type: "failed";
      error: { code: string; message: string; durability: ForeignDurability; retryable: boolean };
    };
export type ForeignToolContinueRequest = {
  continuation: ForeignContinuation;
  response: { kind: "sample" | "elicit" | "cancel"; value: Json };
};
export interface DurableJoinDescriptor {
  kind: "join";
  handle: DurableTaskHandle;
}
export interface RecordedOperationDescriptor {
  kind: "record";
  /** Stable identity for one execution-owned recorded operation. */
  key: string;
  /** Retry classification for execution-owned recorded operations. */
  retrySafety: RetrySafety;
}
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
export interface EmissionDescriptor {
  eventType: string;
  payload: Json;
}
export type { OperationOutcome, RetrySafety };
