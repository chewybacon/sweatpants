/**
 * Durable contract declarations.
 *
 * The pinned, portable vocabulary an authored program is written against:
 * manifests, effect definitions, operation descriptors, and outcomes. This is
 * the leaf layer; nothing here may depend on the authority, the driver
 * protocol, or the authoring surface.
 */

import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema-descriptor";
import type { Json } from "./types.ts";
import type {
  DurableEffectDisposition as CanonicalDurableEffectDisposition,
  EffectDefinition as CanonicalEffectDefinition,
  EffectDescriptor as CanonicalEffectDescriptor,
  OperationOutcome as CanonicalOperationOutcome,
  RetrySafety as CanonicalRetrySafety,
} from "@sweatpants/durable-effects";

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
      /** Covers declared schemas, effects, elicitations, capabilities, name, and version. */
      readonly kind: "generated-interface";
      readonly format: typeof PROGRAM_INTERFACE_IDENTITY_FORMAT;
      readonly generatorVersion: number;
      readonly identityInputDigest: string;
    }
  | {
      /** Covers the declared interface plus a separately generated implementation artifact. */
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

/** Portable JSON Schema projection carried on wire/browser transports. */
export type JsonSchema = Json;

/** Canonical durable-effects retry declaration. */
export type RetrySafety = CanonicalRetrySafety;

/** Canonical durable-effects contract identity. */
export type EffectDefinition<
  I extends Json = Json,
  O extends Json = Json,
  P extends Json = never,
> = CanonicalEffectDefinition<I, O, P>;

/** Canonical durable-effects terminal disposition. */
export type DurableEffectDisposition<
  O extends Json,
  P extends Json = never,
> = CanonicalDurableEffectDisposition<O, P>;

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

/** Canonical journaled host-effect request. */
export type EffectDescriptor = CanonicalEffectDescriptor;

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

/** Canonical persisted effect/record outcome algebra. */
export type OperationOutcome = CanonicalOperationOutcome;
