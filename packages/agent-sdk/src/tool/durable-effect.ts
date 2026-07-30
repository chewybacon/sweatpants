import { defineDurableEffect } from "@sweatpants/durable-effects/authoring";
import { type EffectDefinition, type RetrySafety } from "@sweatpants/durable-effects";

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type Json } from "@sweatpants/foundation";
import { type SchemaBinding } from "@sweatpants/foundation/schema";

import { toPortableSchema } from "../schema/zod-adapter.ts";

type JsonOutput<T> = T extends Json ? T : never;

/** Runtime validators retained beside one authored durable effect. */
export interface DurableEffectRuntimeValidators {
  readonly input: StandardSchemaV1;
  readonly output: StandardSchemaV1;
  readonly cancellationPartial?: StandardSchemaV1;
}

const effectCatalogs = new WeakMap<EffectDefinition<Json, Json, Json>, readonly SchemaBinding[]>();
const effectValidators = new WeakMap<
  EffectDefinition<Json, Json, Json>,
  DurableEffectRuntimeValidators
>();

/** Standard Schema authoring options for one versioned durable effect contract. */
export interface DefineEffectOptions<
  ISchema extends StandardSchemaV1,
  OSchema extends StandardSchemaV1,
  PSchema extends StandardSchemaV1 | undefined,
> {
  readonly name: string;
  /**
   * Explicit semantic effect version; any validator behavior change (including
   * refinements/transforms invisible to JSON Schema) requires a bump.
   */
  readonly version: string;
  readonly input: ISchema;
  readonly output: OSchema;
  readonly cancellationPartial?: PSchema;
  readonly retrySafety: RetrySafety;
  /** Explicit trusted output projections for transformed schemas. */
  readonly projections?: {
    readonly inputProjection?: Json;
    readonly outputProjection?: Json;
    readonly cancellationPartialProjection?: Json;
  };
}

/**
 * Authors a durable effect contract with Standard Schema validators. The persisted
 * `EffectDefinition` carries only portable descriptors; runtime validators and
 * digest-keyed catalog entries stay scope-local beside the definition.
 */
export function defineEffect<
  ISchema extends StandardSchemaV1,
  OSchema extends StandardSchemaV1,
  PSchema extends StandardSchemaV1 | undefined = undefined,
>(
  options: DefineEffectOptions<
    ISchema,
    OSchema,
    PSchema extends StandardSchemaV1 ? PSchema : never
  >,
): EffectDefinition<
  JsonOutput<StandardSchemaV1.InferOutput<ISchema>>,
  JsonOutput<StandardSchemaV1.InferOutput<OSchema>>,
  PSchema extends StandardSchemaV1 ? JsonOutput<StandardSchemaV1.InferOutput<PSchema>> : never
> {
  const identity = `effect:${options.name}`;
  const catalog: SchemaBinding[] = [];
  const input = toPortableSchema(options.input, {
    identity: `${identity}/input`,
    role: "effect_input",
    version: options.version,
    ...(options.projections?.inputProjection !== undefined
      ? { inputProjection: options.projections.inputProjection }
      : {}),
  });
  catalog.push(input.entry);
  const output = toPortableSchema(options.output, {
    identity: `${identity}/output`,
    role: "effect_output",
    version: options.version,
    ...(options.projections?.outputProjection !== undefined
      ? { outputProjection: options.projections.outputProjection }
      : {}),
  });
  catalog.push(output.entry);
  let cancellation;
  let partialValidator: StandardSchemaV1 | undefined;
  if (options.cancellationPartial) {
    const partial = toPortableSchema(options.cancellationPartial, {
      identity: `${identity}/cancellation-partial`,
      role: "effect_cancellation_partial",
      version: options.version,
      ...(options.projections?.cancellationPartialProjection !== undefined
        ? { outputProjection: options.projections.cancellationPartialProjection }
        : {}),
    });
    catalog.push(partial.entry);
    cancellation = { partialSchema: partial.descriptor };
    partialValidator = options.cancellationPartial;
  }
  const definition = defineDurableEffect({
    name: options.name,
    version: options.version,
    inputSchema: input.descriptor,
    outputSchema: output.descriptor,
    ...(cancellation ? { cancellation } : {}),
    retrySafety: options.retrySafety,
  });
  effectCatalogs.set(definition, Object.freeze(catalog));
  effectValidators.set(definition, {
    input: options.input,
    output: options.output,
    ...(partialValidator ? { cancellationPartial: partialValidator } : {}),
  });
  // SAFETY: JsonOutput type witnesses are pinned by the authored Standard Schema validators
  // whose validators are registered under the descriptor digests.
  return definition as unknown as EffectDefinition<
    JsonOutput<StandardSchemaV1.InferOutput<ISchema>>,
    JsonOutput<StandardSchemaV1.InferOutput<OSchema>>,
    PSchema extends StandardSchemaV1 ? JsonOutput<StandardSchemaV1.InferOutput<PSchema>> : never
  >;
}

/** Digest-keyed validator entries authored beside one effect definition. */
export function effectCatalogEntries(
  definition: EffectDefinition<Json, Json, Json>,
): readonly SchemaBinding[] {
  return effectCatalogs.get(definition) ?? [];
}

/** Runtime validators authored beside one effect definition, if Zod-authored. */
export function effectRuntimeValidators(
  definition: EffectDefinition<Json, Json, Json>,
): DurableEffectRuntimeValidators | undefined {
  return effectValidators.get(definition);
}
