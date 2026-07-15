import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  DurableSchemaRegistryEntry,
  PortableSchemaDescriptor,
} from "@sweatpants/session-contract";

import type {
  ElicitsMap,
  NormalizedElicitsMap,
  NormalizedSamplesMap,
  SamplesMap,
  ToolExtensionMetadata,
} from "./types.ts";

/**
 * Execution-neutral public tool contract.
 *
 * `ToolContract` carries only immutable public metadata, runtime Standard
 * Schema references, normalized elicitation/sampling declarations, portable
 * schema artifacts, and capability metadata. It deliberately contains no
 * execution function, handler, route, credential, or transport handle —
 * deployment composition, not the contract, selects placement.
 *
 * Ordinary `ToolDefinition` (adds the callable Effection factory) and durable
 * `DurableToolDefinition` (adds the pinned manifest and pure program) both
 * satisfy this contract structurally.
 */

/** Closed execution-kind discriminant shared by contract implementations. */
export type ToolExecutionKind = "ordinary" | "crank_native";

/** Portable descriptors for one declared elicitation (content-schema semantics). */
export interface ToolElicitSchemaArtifact {
  /** Accepted-content descriptor; never the outer wire action envelope. */
  readonly response: PortableSchemaDescriptor;
  readonly context?: PortableSchemaDescriptor;
}

/**
 * Retained portable schema projections plus the digest-keyed runtime
 * validator catalog for one tool. Consumers (inventory, providers, browser
 * forms) use the projections without re-lowering the runtime schema;
 * authorities merge `catalog` entries into scope-local registries.
 */
export interface ToolSchemaArtifacts {
  readonly parameters: PortableSchemaDescriptor;
  readonly output?: PortableSchemaDescriptor;
  readonly elicits: Readonly<Record<string, ToolElicitSchemaArtifact>>;
  /** Runtime validators; never persisted or transported. */
  readonly catalog: readonly DurableSchemaRegistryEntry[];
}

/** Execution-neutral public tool metadata and schema contract. */
export interface ToolContract<
  TName extends string = string,
  TParams = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
  TSamples extends SamplesMap | true | undefined = SamplesMap | true | undefined,
> {
  readonly execution: ToolExecutionKind;
  readonly name: TName;
  readonly description: string;
  readonly parameters: StandardSchemaV1<unknown, TParams>;
  readonly output?: StandardSchemaV1<unknown, TResult> | undefined;
  readonly elicits: NormalizedElicitsMap<TElicits>;
  readonly samples: TSamples extends SamplesMap
    ? NormalizedSamplesMap<TSamples>
    : Readonly<Record<string, never>>;
  readonly artifacts: ToolSchemaArtifacts;
  readonly capabilities: { readonly elicitation: boolean; readonly sampling: boolean };
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly extensions: readonly ToolExtensionMetadata[];
}

/** Erased contract type for registries and heterogeneous collections. */
export type AnyToolContract = ToolContract<string, any, any, any, any>;
