import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { z, ZodSchema } from "zod";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  createInterfaceDerivedPinnedDurableProgram,
  createPinnedDurableProgram as createLowLevelDurableTool,
  generateProgramArtifactIdentity,
  type DurableProgramContext,
  type DurableProgramGenerator,
  type DurableProgramManifest,
  type DurableSchemaRegistryEntry,
  type DurableTool,
  type EffectDefinition,
  type Json,
  type PortableSchemaDescriptor,
  type ProgramResume,
  type ProgramStepProposal,
  type WireElicitResultJson,
} from "@sweatpants/session-contract";

import { toPortableSchema } from "../schema/zod-adapter.ts";
import { effectCatalogEntries } from "./durable-effect.ts";
import type { ToolSchemaArtifacts } from "./contract.ts";
import type {
  ElicitDefinition,
  ElicitsMap,
  ExtractElicitContext,
  ExtractElicitResponse,
  NormalizedElicitsMap,
  ToolExtensionMetadata,
} from "./types.ts";

type JsonOutput<T> = T extends Json ? T : never;
type EffectInput<D> = D extends EffectDefinition<infer I, Json, Json> ? I : never;
type EffectOutput<D> = D extends EffectDefinition<Json, infer O, Json> ? O : never;
type EffectMap = Record<string, EffectDefinition<Json, Json, Json>>;
type EffectFromMap<E extends EffectMap> = E[keyof E];

type ElicitRequestFor<E> =
  ExtractElicitContext<E> extends undefined
    ? { message: string }
    : { message: string; context: ExtractElicitContext<E> };

/** Typed durable program context bound to declared effects and elicitations. */
export type DurableProgramContextFor<E extends EffectMap, TElicits extends ElicitsMap = {}> = Omit<
  DurableProgramContext,
  "effect" | "elicit"
> & {
  effect<D extends EffectFromMap<E>>(
    definition: D,
    input: EffectInput<D>,
    resolver?: { audience: string; route?: string },
  ): Generator<ProgramStepProposal, EffectOutput<D>, ProgramResume>;
  /**
   * Proposes a declared elicitation with the canonical authored context only.
   * Resumes with the typed wire action envelope; an explicit task cancellation
   * is a separate `DurableProgramCancellation` and never an envelope.
   */
  elicit<K extends keyof TElicits & string>(
    key: K,
    request: ElicitRequestFor<TElicits[K]>,
  ): Generator<
    ProgramStepProposal,
    WireElicitResultJson<JsonOutput<ExtractElicitResponse<TElicits[K]>>>,
    ProgramResume
  >;
};

/**
 * Crank-native durable tool definition satisfying the execution-neutral
 * `ToolContract` while adding the pinned manifest and pure program.
 */
export type DurableToolDefinition<
  N extends string = string,
  I extends Json = Json,
  O extends Json = Json,
  TElicits extends ElicitsMap = {},
> = DurableTool<I, O> & {
  readonly execution: "crank_native";
  readonly durability: "crank_native";
  readonly name: N;
  readonly description: string;
  readonly parameters: StandardSchemaV1<unknown, I>;
  readonly output?: StandardSchemaV1<unknown, O> | undefined;
  readonly elicits: NormalizedElicitsMap<TElicits>;
  readonly samples: Readonly<Record<string, never>>;
  readonly artifacts: ToolSchemaArtifacts;
  readonly capabilities: { readonly elicitation: boolean; readonly sampling: boolean };
  readonly annotations: Readonly<Record<string, unknown>>;
  readonly extensions: readonly ToolExtensionMetadata[];
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableTool<I, O>["program"];
};

/** Compatibility alias for the previous fluent durable tool name. */
export type FluentDurableTool<
  N extends string,
  I extends Json,
  O extends Json,
> = DurableToolDefinition<N, I, O>;

export interface CreateDurableToolOptions {
  readonly version: string;
  /** Build-generated source-closure digest. Omit for an interface-only identity. */
  readonly implementationArtifactDigest?: string;
  readonly resourcePackageDigests?: readonly string[];
}

export interface CreateDurableToolBuilderBase<N extends string> {
  description(description: string): CreateDurableToolBuilderWithDescription<N>;
}

export interface CreateVersionedDurableToolBuilderBase<N extends string> {
  description(description: string): CreateDurableToolBuilderWithIdentity<N>;
}

export interface CreateDurableToolBuilderWithDescription<N extends string> {
  identity(identity: { version: string; digest: string }): CreateDurableToolBuilderWithIdentity<N>;
}

export interface CreateDurableToolBuilderWithIdentity<N extends string> {
  parameters<S extends ZodSchema>(
    schema: S & (z.infer<S> extends Json ? unknown : never),
  ): CreateDurableToolBuilderWithParameters<N, JsonOutput<z.infer<S>>, undefined, {}>;
}

export interface CreateDurableToolBuilderWithParameters<
  N extends string,
  I extends Json,
  O extends Json | undefined,
  E extends ElicitsMap,
> {
  output<S extends ZodSchema>(
    schema: S & (z.infer<S> extends Json ? unknown : never),
  ): CreateDurableToolBuilderWithParameters<N, I, JsonOutput<z.infer<S>>, E>;
  elicits<Next extends ElicitsMap>(
    elicits: Next,
  ): CreateDurableToolBuilderWithParameters<N, I, O, Next>;
  effects<Effects extends EffectMap>(
    effects: Effects,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects>;
}

export interface CreateDurableToolBuilderReady<
  N extends string,
  I extends Json,
  O extends Json | undefined,
  E extends ElicitsMap,
  Effects extends EffectMap,
> {
  execute<Result extends O extends Json ? O : Json>(
    program: (
      input: I,
      context: DurableProgramContextFor<Effects, E>,
    ) => DurableProgramGenerator<Result>,
  ): DurableToolDefinition<N, I, O extends Json ? O : Result, E>;
}

type BuilderState = {
  name: string;
  description?: string;
  identity?: { version: string; digest: string };
  version?: string;
  implementationArtifactDigest?: string;
  resourcePackageDigests?: readonly string[];
  parameters?: ZodSchema;
  output?: ZodSchema;
  elicits?: ElicitsMap;
  effects?: EffectMap;
};

/** Creates a type-staged Zod authoring adapter over the low-level durable manifest API. */
export function createDurableTool<N extends string>(name: N): CreateDurableToolBuilderBase<N>;
export function createDurableTool<N extends string>(
  name: N,
  options: CreateDurableToolOptions,
): CreateVersionedDurableToolBuilderBase<N>;
export function createDurableTool<N extends string>(
  name: N,
  options?: CreateDurableToolOptions,
): CreateDurableToolBuilderBase<N> | CreateVersionedDurableToolBuilderBase<N> {
  requireNonEmpty(name, "name");
  if (!options) {
    return builder({ name }) as CreateDurableToolBuilderBase<N>;
  }
  requireNonEmpty(options.version, "version");
  if (
    options.implementationArtifactDigest &&
    !/^[0-9a-f]{64}$/.test(options.implementationArtifactDigest)
  ) {
    throw new Error(
      `Durable tool "${name}": implementationArtifactDigest must be lowercase SHA-256 hex`,
    );
  }
  if (options.resourcePackageDigests?.length && !options.implementationArtifactDigest) {
    throw new Error(
      `Durable tool "${name}": resourcePackageDigests require implementationArtifactDigest`,
    );
  }
  for (const digest of options.resourcePackageDigests ?? []) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `Durable tool "${name}": resourcePackageDigests must be lowercase SHA-256 hex`,
      );
    }
  }
  return builder({
    name,
    version: options.version,
    ...(options.implementationArtifactDigest
      ? { implementationArtifactDigest: options.implementationArtifactDigest }
      : {}),
    ...(options.resourcePackageDigests
      ? { resourcePackageDigests: [...options.resourcePackageDigests] }
      : {}),
  }) as CreateVersionedDurableToolBuilderBase<N>;
}

function builder(state: BuilderState): unknown {
  return {
    description(description: string) {
      requireNonEmpty(description, "description");
      return builder({ ...state, description });
    },
    identity(identity: { version: string; digest: string }) {
      requireStage(state.description, ".description()", ".identity()");
      requireNonEmpty(identity.version, "identity.version");
      if (!/^[0-9a-f]{64}$/.test(identity.digest)) {
        throw new Error(
          `Durable tool "${state.name}": identity.digest must be lowercase SHA-256 hex`,
        );
      }
      return builder({ ...state, identity: { ...identity } });
    },
    parameters(parameters: ZodSchema) {
      requireStage(
        state.identity ?? state.version,
        ".identity() or a version option",
        ".parameters()",
      );
      return builder({ ...state, parameters });
    },
    output(output: ZodSchema) {
      requireStage(state.parameters, ".parameters()", ".output()");
      return builder({ ...state, output });
    },
    elicits(elicits: ElicitsMap) {
      requireStage(state.parameters, ".parameters()", ".elicits()");
      return builder({ ...state, elicits: { ...elicits } });
    },
    effects(effects: EffectMap) {
      requireStage(state.parameters, ".parameters()", ".effects()");
      return builder({ ...state, effects: { ...effects } });
    },
    execute(program: (input: Json, context: DurableProgramContext) => DurableProgramGenerator) {
      requireStage(state.description, ".description()", ".execute()");
      requireStage(
        state.identity ?? state.version,
        ".identity() or a version option",
        ".execute()",
      );
      requireStage(state.parameters, ".parameters()", ".execute()");
      requireStage(state.effects, ".effects()", ".execute()");
      const version = state.identity?.version ?? state.version!;
      const description = state.description!;
      const normalizedElicits = normalizeElicits(state.elicits ?? {});
      const catalog: DurableSchemaRegistryEntry[] = [];
      const identityPrefix = `program:${state.name}`;

      const input = toPortableSchema(state.parameters as unknown as StandardSchemaV1, {
        identity: `${identityPrefix}/input`,
        role: "program_input",
        version,
      });
      catalog.push(input.entry);
      let outputDescriptor: PortableSchemaDescriptor;
      if (state.output) {
        const output = toPortableSchema(state.output as unknown as StandardSchemaV1, {
          identity: `${identityPrefix}/output`,
          role: "program_output",
          version,
        });
        catalog.push(output.entry);
        outputDescriptor = output.descriptor;
      } else {
        // Undeclared program output remains any bounded canonical JSON through
        // the built-in descriptor whose validator every registry retains.
        outputDescriptor = ANY_JSON_SCHEMA_DESCRIPTOR;
      }

      const manifestElicits: Record<
        string,
        { response: PortableSchemaDescriptor; context?: PortableSchemaDescriptor }
      > = {};
      const elicitArtifacts: Record<
        string,
        { response: PortableSchemaDescriptor; context?: PortableSchemaDescriptor }
      > = {};
      for (const [key, definition] of Object.entries(normalizedElicits)) {
        const response = toPortableSchema(definition.response as unknown as StandardSchemaV1, {
          identity: `${identityPrefix}/elicits/${key}/response`,
          role: "elicit_response",
          version,
        });
        catalog.push(response.entry);
        let context;
        if (definition.context) {
          context = toPortableSchema(definition.context as unknown as StandardSchemaV1, {
            identity: `${identityPrefix}/elicits/${key}/context`,
            role: "elicit_context",
            version,
          });
          catalog.push(context.entry);
        }
        const declaration = {
          response: response.descriptor,
          ...(context ? { context: context.descriptor } : {}),
        };
        manifestElicits[key] = declaration;
        elicitArtifacts[key] = declaration;
      }

      // Effect schema catalog entries travel with their authored definitions;
      // the manifest embeds only their descriptors.
      for (const definition of Object.values(state.effects!)) {
        catalog.push(...effectCatalogEntries(definition));
      }
      const manifest = {
        programId: state.name,
        version,
        inputSchema: input.descriptor,
        outputSchema: outputDescriptor,
        elicits: manifestElicits,
        effects: state.effects!,
        capabilities: {
          durableEmissions: true,
          structuredChildren: true,
          replay: "strict" as const,
        },
      };
      const factory = (rawInput: Json, context: DurableProgramContext) =>
        program(rawInput, contextForDeclarations(context, manifestElicits));
      const tool = state.identity
        ? createLowLevelDurableTool({ ...manifest, digest: state.identity.digest }, factory)
        : state.implementationArtifactDigest
          ? createGeneratedPinnedDurableProgram(
              generateProgramArtifactIdentity({
                format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
                generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
                manifest,
                implementationArtifactDigest: state.implementationArtifactDigest,
                resourcePackageDigests: [...(state.resourcePackageDigests ?? [])],
              }),
              factory,
            )
          : createInterfaceDerivedPinnedDurableProgram(manifest, factory);
      const artifacts: ToolSchemaArtifacts = Object.freeze({
        parameters: input.descriptor,
        output: outputDescriptor,
        elicits: Object.freeze(elicitArtifacts),
        catalog: Object.freeze(catalog),
      });
      return Object.freeze({
        ...tool,
        execution: "crank_native" as const,
        name: state.name,
        description,
        parameters: state.parameters,
        ...(state.output ? { output: state.output } : {}),
        elicits: normalizedElicits,
        samples: Object.freeze({}),
        artifacts,
        capabilities: Object.freeze({
          elicitation: Object.keys(normalizedElicits).length > 0,
          sampling: false,
        }),
        annotations: Object.freeze({}),
        extensions: Object.freeze([]),
      });
    },
  };
}

function contextForDeclarations(
  context: DurableProgramContext,
  elicits: Record<
    string,
    { response: PortableSchemaDescriptor; context?: PortableSchemaDescriptor }
  >,
): DurableProgramContext {
  const adapted = Object.freeze({
    ...context,
    effect(
      definitionOrName: EffectDefinition<Json, Json, Json> | string,
      inputOrVersion: Json,
      resolverOrInput?: Json | { audience: string; route?: string },
      explicitResolver?: { audience: string; route?: string },
    ) {
      if (typeof definitionOrName === "string") {
        return context.effect(
          definitionOrName,
          String(inputOrVersion),
          resolverOrInput as Json,
          explicitResolver!,
        );
      }
      const resolver = resolverOrInput as { audience: string; route?: string } | undefined;
      return context.effect(
        definitionOrName,
        inputOrVersion,
        resolver ?? { audience: `effect:${definitionOrName.name}` },
      );
    },
    elicit(
      key: string,
      requestOrMessage: { message: string; context?: Json } | string,
      response?: PortableSchemaDescriptor,
      rawContext?: Json,
    ) {
      // Low-level escape hatch: (key, message, descriptor, context).
      if (typeof requestOrMessage === "string") {
        return context.elicit(key, requestOrMessage, response!, rawContext);
      }
      const declaration = elicits[key];
      if (!declaration) {
        throw new Error(`Durable tool elicit "${key}" is not declared`);
      }
      return context.elicit(
        key,
        requestOrMessage.message,
        declaration.response,
        requestOrMessage.context,
      );
    },
  });
  // SAFETY: the adapter preserves the low-level overloads while routing the
  // fluent keyed forms through declared descriptors and default resolvers.
  return adapted as DurableProgramContext;
}

function normalizeElicits(
  elicits: ElicitsMap,
): Record<string, ElicitDefinition<ZodSchema, ZodSchema | undefined>> {
  return Object.fromEntries(
    Object.entries(elicits).map(([key, entry]) => {
      const definition: ElicitDefinition<ZodSchema, ZodSchema | undefined> = isElicitDefinition(
        entry,
      )
        ? { ...entry }
        : { response: entry };
      if (definition.response === undefined) {
        throw new Error(`Durable tool elicit "${key}" is missing a response schema`);
      }
      return [key, definition];
    }),
  );
}

function isElicitDefinition(value: unknown): value is ElicitDefinition<ZodSchema, ZodSchema> {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { safeParse?: unknown }).safeParse !== "function" &&
    !("~standard" in (value as object)) &&
    "response" in value,
  );
}

function requireStage(value: unknown, required: string, attempted: string): void {
  if (value === undefined) {
    throw new Error(`Durable tool builder: ${required} must be called before ${attempted}`);
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`Durable tool builder: ${field} must be non-empty`);
  }
}
