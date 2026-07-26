import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ElicitsMap,
  NormalizedElicitsMap,
  NormalizedSamplesMap,
  SamplesMap,
  ToolDefinition,
  ToolExtensionMetadata,
  ToolSchemaArtifacts,
} from "./types.ts";

export type { ToolElicitSchemaArtifact, ToolSchemaArtifacts } from "./types.ts";

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

/**
 * True when a contract value carries an executable ordinary factory (i.e. it
 * is a full `ToolDefinition`, not a metadata-only projection). Substrates
 * that run the tool in-process must check this before invoking.
 */
export function isExecutableToolContract<
  TName extends string,
  TParams,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
>(
  contract: ToolContract<TName, TParams, TResult, TElicits, TSamples>,
): contract is ToolContract<TName, TParams, TResult, TElicits, TSamples> &
  ToolDefinition<TName, TParams, TResult, TElicits, TSamples> {
  const candidate: unknown = contract;
  return typeof candidate === "function" && contract.execution === "ordinary";
}

/**
 * F4: project the portable, non-executable contract of an authored tool.
 *
 * The projection carries identity, runtime Standard Schemas, normalized
 * elicit/sample declarations, portable schema artifacts, capabilities,
 * annotations, and extensions — but no executable factory. Worker-backed and
 * remote registrations can consume this projection so the host process never
 * needs the implementation closure (or its implementation-only imports),
 * while the worker entry imports the same single authored definition.
 */
export function projectToolContract<
  TName extends string,
  TParams,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
>(
  tool: ToolContract<TName, TParams, TResult, TElicits, TSamples>,
): ToolContract<TName, TParams, TResult, TElicits, TSamples> {
  return Object.freeze({
    execution: tool.execution,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.output !== undefined ? { output: tool.output } : {}),
    elicits: tool.elicits,
    samples: tool.samples,
    artifacts: tool.artifacts,
    capabilities: tool.capabilities,
    annotations: tool.annotations,
    extensions: tool.extensions,
  }) as ToolContract<TName, TParams, TResult, TElicits, TSamples>;
}
