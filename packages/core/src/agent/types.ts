import { type EffectDefinition } from "@sweatpants/session-contract";

import type {
  DurableSchemaRegistryEntry,
  DurableTool,
  Json,
  PinnedProgram,
  ProgramIdentityProvenanceV1,
} from "@sweatpants/session-contract";
import type { ResourcePackage, ResourceReaderPrograms } from "../resource/index.ts";

export const AGENT_MANIFEST_FORMAT = "sweatpants.agent-manifest.v1" as const;
export const AGENT_MANIFEST_DOMAIN = `${AGENT_MANIFEST_FORMAT}\n`;

export type AgentAuthoringErrorCode =
  | "invalid_agent_manifest"
  | "program_binding_missing"
  | "effect_contract_conflict";

export interface PinnedAgentProgramV1 extends PinnedProgram {
  readonly provenance: ProgramIdentityProvenanceV1;
}

export interface AdvertisedCapabilityV1 {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly examples: readonly string[];
  readonly inputModes: readonly string[];
  readonly outputModes: readonly string[];
  readonly authorization: string;
}

export interface AgentManifestV1 {
  readonly format: typeof AGENT_MANIFEST_FORMAT;
  readonly identity: {
    readonly name: string;
    readonly version: string;
    readonly digest: string;
  };
  readonly description: string;
  readonly conversation?: PinnedAgentProgramV1;
  readonly programs: Readonly<Record<string, PinnedAgentProgramV1>>;
  readonly advertisedCapabilities: Readonly<Record<string, AdvertisedCapabilityV1>>;
}

/** Local executable/schema/resource realization of one exact program. */
// Runtime inventories intentionally erase program I/O after retaining exact schemas.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
export interface AgentProgramBinding<I extends Json = any, O extends Json = Json> {
  readonly program: DurableTool<I, O>;
  readonly schemas: readonly DurableSchemaRegistryEntry[];
  readonly resources: readonly ResourcePackage[];
  readonly readers?: ResourceReaderPrograms;
}

// oxlint-disable-next-line typescript-eslint/no-explicit-any
export type AgentProgramInput<I extends Json = any, O extends Json = Json> =
  | DurableTool<I, O>
  | AgentProgramBinding<I, O>;

export interface AgentRuntimeBindings {
  readonly conversation?: AgentProgramBinding;
  readonly programs: Readonly<Record<string, AgentProgramBinding>>;
  readonly effects: Readonly<Record<string, EffectDefinition<Json, Json, Json>>>;
  readonly schemas: readonly DurableSchemaRegistryEntry[];
  readonly resources: readonly ResourcePackage[];
}

export interface AgentDefinition {
  readonly kind: "sweatpants.agent-definition.v1";
  readonly manifest: AgentManifestV1;
  readonly bindings: AgentRuntimeBindings;
  /** Deliberately rejects accidental portable serialization of runtime bindings. */
  toJSON(): never;
}

export interface DefineAgentOptions {
  readonly identity: { readonly name: string; readonly version: string };
  readonly description: string;
  readonly conversation?: AgentProgramInput;
  readonly programs?: Readonly<Record<string, AgentProgramInput>>;
  readonly advertisedCapabilities?: Readonly<Record<string, AdvertisedCapabilityV1>>;
  readonly releaseStrict?: boolean;
}
