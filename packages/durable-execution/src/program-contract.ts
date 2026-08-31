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
    {
      response: PortableSchemaDescriptor;
      context?: PortableSchemaDescriptor;
      contextContract?: PortableSchemaDescriptor;
    }
  >;
  effects: Record<string, EffectDefinition<Json, Json, Json>>;
  /** Typed contracts for generic `pull` descriptors keyed by pull kind. */
  pulls?: Record<
    string,
    { readonly input: PortableSchemaDescriptor; readonly output: PortableSchemaDescriptor }
  >;
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
  contextContract?: PortableSchemaDescriptor;
  context?: Json;
  /** Authored compatibility address attached by the trusted host, absent for generic programs. */
  binding?: { readonly id: string };
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
/** Closed durability classification for one fork member (REQ-035).
 *  `crank_native` members execute under the local crank; `peer_hosted`
 *  members execute under a peer authority and carry a declared sampling
 *  mode (REQ-042) — metering truth requires the choice be explicit. */
export type DurableChildDurability =
  | { kind: "crank_native" }
  | { kind: "peer_hosted"; peer: string; sampling: "delegated" | "private" };

export interface DurableChildDescriptor extends PinnedProgram {
  input: Json;
  /** Absent means `crank_native` — the pre-fork behavior. */
  durability?: DurableChildDurability;
}
export interface DurableInvokeDescriptor {
  kind: "invoke";
  child: DurableChildDescriptor;
}
/** Fork expiry policy: explicit deadline, relative duration, or inheritance
 *  through ancestors. No default and no library constant exist. */
export type DurableForkExpiry =
  | { kind: "at"; atMs: number }
  | { kind: "after"; durationMs: number }
  | { kind: "inherit" };
export interface DurableAllDescriptor {
  kind: "all";
  /** Closed pairing: `all` requires one-for-all supervision. */
  supervision: "one_for_all";
  children: DurableChildDescriptor[];
  expiry: DurableForkExpiry;
}
export interface DurableRaceDescriptor {
  kind: "race";
  /** Closed pairing: `race` requires first-success supervision. */
  supervision: "first_success";
  children: DurableChildDescriptor[];
  expiry: DurableForkExpiry;
}
export interface DurableSpawnDescriptor {
  kind: "spawn";
  child: DurableChildDescriptor;
}
export interface DurableTaskHandle {
  __durableTask: string;
  owner: string;
}
export type EphemeralDurability =
  | "opaque"
  | "ephemeral_handle"
  | "resumable_handle"
  | "server_task"
  | "crank_native";
/** Model-sampling pull proposed by a journaled program; input is the canonical wire request. */
export interface DurableSampleDescriptor {
  kind: "sample";
  input: Json;
}
export type EphemeralToolRequest = {
  driver: string;
  tool: string;
  input: Json;
  durability: EphemeralDurability;
  route?: string;
};
/** Session-bound live tool call proposed by a journaled program. */
export interface DurableEphemeralDescriptor {
  kind: "ephemeral";
  driver: string;
  tool: string;
  input: Json;
  durability: EphemeralDurability;
}
export type EphemeralContinuation = { driver: string; state: Json };
export type ProgramElicitResult<T extends Json = Json> =
  | { action: "accept"; content: T }
  | { action: "decline"; reason?: string }
  | { action: "cancel"; reason?: string };
export type EphemeralInputRequest =
  | { kind: "sample"; payload: Json }
  | {
      kind: "elicit";
      key: string;
      message: string;
      responseSchema: JsonSchema;
      context?: Json;
      /** Structurally identical to agent-sdk InteractionBinding without a dependency cycle. */
      binding: { readonly id: string };
    };
export type EphemeralToolDisposition =
  | { type: "input_required"; request: EphemeralInputRequest; continuation: EphemeralContinuation }
  | { type: "completed"; result: Json }
  | {
      type: "failed";
      error: { code: string; message: string; durability: EphemeralDurability; retryable: boolean };
    };
export type EphemeralToolContinueRequest = {
  continuation: EphemeralContinuation;
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
  | DurableSampleDescriptor
  | DurableEphemeralDescriptor
  | DurableAllDescriptor
  | DurableRaceDescriptor
  | DurableSpawnDescriptor
  | DurableJoinDescriptor;
export interface EmissionDescriptor {
  eventType: string;
  payload: Json;
}
export type { OperationOutcome, RetrySafety };
