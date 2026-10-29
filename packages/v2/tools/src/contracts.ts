import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest, EffectDefinition } from "@sweatpan.ts/core";
import type { LogicalScope, ScopeInstruction } from "@sweatpan.ts/execution";
import type { EffectCapabilities } from "@sweatpan.ts/hosting";

/** Authored operations available inside an evaluator-owned tool body. */
export interface ToolContext<
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  Y,
> {
  /** Calls declared capabilities; the host must separately grant their authority. */
  readonly capabilities: { readonly [K in keyof D]: D[K]["call"] };
  /** Logical scope owning the body's registered cleanup and critical regions. */
  readonly scope: LogicalScope;
  /** Existing journal sandwich; omitted keys use positional recording identity. */
  readonly record: ReturnType<EffectCapabilities<Y>["grant"]>["record"];
  /**
   * Execute a Promise factory through the existing recording grant. Accepted values
   * replay without executing the factory. Rejection remains a delivery error and
   * leaves the attempt unsettled. Unrecorded Promise execution is not supported.
   */
  await<T>(
    start: (signal: AbortSignal) => PromiseLike<T>,
    options: { readonly record: { readonly key?: string } },
  ): Operation<T, CapabilityRequest>;
  /** Request a declared external interaction, preserving its input and reply types. */
  elicit<K extends keyof L>(key: K, ...args: Parameters<L[K]["call"]>): ReturnType<L[K]["call"]>;
}

/**
 * An ordinary callable effect whose implementation is an evaluator-owned body.
 * Input is normalized by admission before acquisition. Result inference is not
 * runtime result validation. Declaration alone grants no invocation authority.
 */
export interface ToolDefinition<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition>,
  L extends Record<string, EffectDefinition>,
  R,
> extends EffectDefinition<
  StandardSchemaV1.InferOutput<S>,
  R,
  StandardSchemaV1.InferInput<S>,
  R,
  never
> {
  /** Original parameter schema, retained for admission and contract inspection. */
  readonly context: S;
  /** Capability declarations available to the body; implementations remain host-owned. */
  readonly capabilities: D;
  /** External interactions, represented by the same effect primitive. */
  readonly elicits: L;
  /** Controlled iterator body; arbitrary native runtime yields are not supported. */
  readonly body: <Y>(
    input: StandardSchemaV1.InferOutput<S>,
    ctx: ToolContext<D, L, Y>,
  ) => Operation<R, CapabilityRequest | ScopeInstruction>;
}

/** Immutable builder retaining schema, capability and elicitation inference. */
export interface ToolBuilder<
  S extends StandardSchemaV1,
  D extends Record<string, EffectDefinition> = {},
  L extends Record<string, EffectDefinition> = {},
> {
  /** Replace the declared capabilities without granting execution authority. */
  capabilities<const Next extends Record<string, EffectDefinition>>(
    definitions: Next,
  ): ToolBuilder<S, Next, L>;
  /** Replace the declared external interactions. */
  elicits<const Next extends Record<string, EffectDefinition>>(
    definitions: Next,
  ): ToolBuilder<S, D, Next>;
  /** Finish the declaration, inferring the terminal result from the body. */
  execute<R>(body: ToolDefinition<S, D, L, R>["body"]): ToolDefinition<S, D, L, R>;
}
