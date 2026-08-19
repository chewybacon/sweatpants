import type { ModelSampleRequest } from "@sweatpants/model-sampling";
import {
  MODEL_SAMPLE_EFFECT,
  MODEL_SAMPLE_SCHEMA_ENTRIES,
  sampleDurableModel,
} from "@sweatpants/model-sampling";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";
import type { ModelContext } from "@sweatpants/model-provider";
import { type EffectDefinition } from "@sweatpants/durable-effects";

import { CrankError } from "@sweatpants/durable-execution";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";
import { z } from "zod";
import { sha256, sortStrings, stableTupleHash } from "@sweatpants/foundation";
import { safeSchemaIssues, validateAuthoredSchema } from "@sweatpants/foundation/parser";
import { effectContractDigest } from "@sweatpants/durable-effects/runtime";
import { type Json, type JsonObject } from "@sweatpants/foundation";
import {
  PROGRAM_ARTIFACT_GENERATOR_VERSION,
  PROGRAM_ARTIFACT_IDENTITY_FORMAT,
  createGeneratedPinnedDurableProgram,
  createInterfaceDerivedPinnedDurableProgram,
  createPinnedDurableProgram as createLowLevelDurableTool,
  generateProgramArtifactIdentity,
  type DurableProgramContext,
  type DurableProgramManifest,
  type DurableTool,
  type ProgramElicitResult,
} from "@sweatpants/durable-execution";
import { ANY_JSON_SCHEMA_DESCRIPTOR } from "@sweatpants/durable-execution";
import { type SchemaBinding, type PortableSchemaDescriptor } from "@sweatpants/foundation/schema";

import { toPortableSchema } from "../schema/zod-adapter.ts";
import { buildToolSchemaArtifacts } from "./artifacts.ts";
import { effectCatalogEntries } from "./durable-effect.ts";
import { projectModelSampleCompletion } from "./exchange.ts";
import {
  assertDurableExtensionDeclarations,
  type DurableExtensionContext,
  type DurableExtensionMap,
} from "./durable-context-extension.ts";
import { computeToolInterfaceDigest, type ToolSchemaArtifacts } from "./contract.ts";
import {
  compileToolInteractionBindings,
  type ToolInteractionBindings,
} from "./interaction-binding.ts";
import type {
  ElicitDefinition,
  ElicitsMap,
  ExtractElicitContextInput,
  ExtractElicitResponse,
  NormalizedElicitsMap,
  ToolExtensionMetadata,
  SchemaProjectionOptions,
  SampleExchangeCompletion,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "./types.ts";

type JsonCompatible<T> = [T] extends [null | boolean | number | string | undefined]
  ? true
  : [T] extends [readonly (infer Item)[]]
    ? JsonCompatible<Item>
    : [T] extends [object]
      ? false extends {
          [Key in keyof T]-?: JsonCompatible<T[Key]>;
        }[keyof T]
        ? false
        : true
      : false;

/**
 * Zod represents an optional object property as `property?: T | undefined`.
 * Canonical JSON permits the property to be absent, but never persists an
 * explicit `undefined`. Preserve the optional modifier while removing
 * `undefined` from the parsed value type.
 */
type JsonOutput<T> = T extends Json
  ? T
  : T extends readonly (infer Item)[]
    ? JsonOutput<Exclude<Item, undefined>>[]
    : T extends object
      ? { [Key in keyof T]: JsonOutput<Exclude<T[Key], undefined>> } & Json
      : never;
type EffectInput<D> = D extends EffectDefinition<infer I, Json, Json> ? I : never;
type EffectOutput<D> = D extends EffectDefinition<Json, infer O, Json> ? O : never;
type EffectMap = Record<string, EffectDefinition<Json, Json, Json>>;
type EffectFromMap<E extends EffectMap> = E[keyof E];
type SamplingTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: StandardSchemaV1 | Readonly<Record<string, unknown>>;
};
type SamplingRequestBase = {
  readonly prompt?: string;
  readonly messages?: readonly ChatMessage[];
  readonly systemPrompt?: string;
  readonly maxTokens?: number;
  readonly modelPreferences?: Json;
  readonly classifications?: readonly Json[];
  readonly retries?: number;
};
type DurableSamplingContext = {
  sample(request: SamplingRequestBase): Operation<SampleExchangeCompletionBase>;
  sampleTools(
    request: SamplingRequestBase & {
      readonly tools: readonly SamplingTool[];
      readonly toolChoice?: "auto" | "none" | "required";
    },
  ): Operation<ToolCallSampleExchangeCompletion>;
  sampleSchema<T>(
    request: SamplingRequestBase & { readonly schema: StandardSchemaV1<unknown, T> },
  ): Operation<ParsedSampleExchangeCompletion<T> & { parsed: T }>;
};

type ElicitRequestFor<E> =
  ExtractElicitContextInput<E> extends undefined
    ? { message: string }
    : { message: string; context: ExtractElicitContextInput<E> };

/** Typed durable program context bound to declared effects and elicitations. */
export type DurableProgramContextFor<
  E extends EffectMap,
  TElicits extends ElicitsMap = {},
  TSamples extends boolean = false,
  TExtensions extends DurableExtensionMap = {},
> = Omit<DurableProgramContext, "effect" | "elicit" | "use"> & {
  effect<D extends EffectFromMap<E>>(
    definition: D,
    input: EffectInput<D>,
    resolver?: { audience: string; route?: string },
  ): Operation<EffectOutput<D>>;
  /**
   * Proposes a declared elicitation with the canonical authored context only.
   * Resumes with the typed wire action envelope; an explicit task cancellation
   * is a separate `DurableProgramCancellation` and never an envelope.
   */
  elicit<K extends keyof TElicits & string>(
    key: K,
    request: ElicitRequestFor<TElicits[K]>,
  ): Operation<ProgramElicitResult<JsonOutput<ExtractElicitResponse<TElicits[K]>>>>;
} & (TSamples extends true ? DurableSamplingContext : {}) &
  DurableExtensionContext<TExtensions>;

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
  readonly interfaceDigest: string;
  readonly bindings: ToolInteractionBindings;
  readonly manifest: DurableProgramManifest<I, O>;
  readonly program: DurableTool<I, O>["program"];
};

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
  parameters<S extends StandardSchemaV1>(
    schema: S & (JsonCompatible<StandardSchemaV1.InferOutput<S>> extends true ? unknown : never),
    projections?: SchemaProjectionOptions,
  ): CreateDurableToolBuilderWithParameters<
    N,
    JsonOutput<StandardSchemaV1.InferOutput<S>>,
    undefined,
    {}
  >;
}

export interface CreateDurableToolBuilderWithParameters<
  N extends string,
  I extends Json,
  O extends Json | undefined,
  E extends ElicitsMap,
> {
  output<S extends StandardSchemaV1>(
    schema: S & (JsonCompatible<StandardSchemaV1.InferOutput<S>> extends true ? unknown : never),
    projections?: SchemaProjectionOptions,
  ): CreateDurableToolBuilderWithParameters<N, I, JsonOutput<StandardSchemaV1.InferOutput<S>>, E>;
  elicits<Next extends ElicitsMap>(
    elicits: Next,
  ): CreateDurableToolBuilderWithParameters<N, I, O, Next>;
  effects<Effects extends EffectMap>(
    effects: Effects,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects, false, {}>;
  samples(): CreateDurableToolBuilderReady<N, I, O, E, {}, true, {}>;
  uses<Extensions extends DurableExtensionMap>(
    extensions: Extensions,
  ): CreateDurableToolBuilderReady<N, I, O, E, {}, false, Extensions>;
  execute<Result extends O extends Json ? O : Json>(
    program: (input: I, context: DurableProgramContextFor<{}, E, false, {}>) => Operation<Result>,
  ): DurableToolDefinition<N, I, O extends Json ? O : Result, E>;
}

export interface CreateDurableToolBuilderReady<
  N extends string,
  I extends Json,
  O extends Json | undefined,
  E extends ElicitsMap,
  Effects extends EffectMap,
  Samples extends boolean = false,
  Extensions extends DurableExtensionMap = {},
> {
  effects<Next extends EffectMap>(
    effects: Next,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects & Next, Samples, Extensions>;
  samples(): CreateDurableToolBuilderReady<N, I, O, E, Effects, true, Extensions>;
  uses<Next extends DurableExtensionMap>(
    extensions: Next,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects, Samples, Extensions & Next>;
  execute<Result extends O extends Json ? O : Json>(
    program: (
      input: I,
      context: DurableProgramContextFor<Effects, E, Samples, Extensions>,
    ) => Operation<Result>,
  ): DurableToolDefinition<N, I, O extends Json ? O : Result, E>;
}

type BuilderState = {
  name: string;
  description?: string;
  identity?: { version: string; digest: string };
  version?: string;
  implementationArtifactDigest?: string;
  resourcePackageDigests?: readonly string[];
  parameters?: StandardSchemaV1;
  parametersProjections?: SchemaProjectionOptions;
  output?: StandardSchemaV1;
  outputProjections?: SchemaProjectionOptions;
  elicits?: ElicitsMap;
  effects?: EffectMap;
  samples?: boolean;
  extensions?: DurableExtensionMap;
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
    parameters(parameters: StandardSchemaV1, projections?: SchemaProjectionOptions) {
      requireStage(
        state.identity ?? state.version,
        ".identity() or a version option",
        ".parameters()",
      );
      return builder({
        ...state,
        parameters,
        ...(projections ? { parametersProjections: projections } : {}),
      });
    },
    output(output: StandardSchemaV1, projections?: SchemaProjectionOptions) {
      requireStage(state.parameters, ".parameters()", ".output()");
      return builder({
        ...state,
        output,
        ...(projections ? { outputProjections: projections } : {}),
      });
    },
    elicits(elicits: ElicitsMap) {
      requireStage(state.parameters, ".parameters()", ".elicits()");
      return builder({ ...state, elicits: { ...elicits } });
    },
    uses(extensions: DurableExtensionMap) {
      requireStage(state.parameters, ".parameters()", ".uses()");
      for (const alias of Object.keys(extensions)) {
        if (state.extensions?.[alias]) {
          throw new Error(`Durable context extension alias ${alias} is already declared`);
        }
      }
      const merged = { ...state.extensions, ...extensions };
      assertDurableExtensionDeclarations(merged);
      return builder({ ...state, extensions: merged });
    },
    effects(effects: EffectMap) {
      requireStage(state.parameters, ".parameters()", ".effects()");
      const samplingDefinition = effects[MODEL_SAMPLE_EFFECT.name];
      if (
        state.samples &&
        samplingDefinition &&
        effectContractDigest(samplingDefinition) !== effectContractDigest(MODEL_SAMPLE_EFFECT)
      ) {
        throw new Error(
          "Durable tool model.sample declaration differs from the canonical contract",
        );
      }
      return builder({ ...state, effects: { ...state.effects, ...effects } });
    },
    samples() {
      requireStage(state.parameters, ".parameters()", ".samples()");
      const samplingDefinition = state.effects?.[MODEL_SAMPLE_EFFECT.name];
      if (
        samplingDefinition &&
        effectContractDigest(samplingDefinition) !== effectContractDigest(MODEL_SAMPLE_EFFECT)
      ) {
        throw new Error(
          "Durable tool model.sample declaration differs from the canonical contract",
        );
      }
      return builder({ ...state, samples: true });
    },
    execute(program: (input: Json, context: DurableProgramContext) => Operation<Json>) {
      requireStage(state.description, ".description()", ".execute()");
      requireStage(
        state.identity ?? state.version,
        ".identity() or a version option",
        ".execute()",
      );
      const parameters = requireStage(state.parameters, ".parameters()", ".execute()");
      const version = state.identity?.version ?? state.version!;
      const description = state.description!;
      const normalizedElicits = normalizeElicits(state.elicits ?? {});
      const catalog: SchemaBinding[] = [];
      const identityPrefix = `program:${state.name}`;

      const input = toPortableSchema(parameters, {
        identity: `${identityPrefix}/input`,
        role: "program_input",
        version,
        ...(state.parametersProjections ?? {}),
      });
      catalog.push(input.entry);
      let outputDescriptor: PortableSchemaDescriptor;
      if (state.output) {
        const output = toPortableSchema(state.output, {
          identity: `${identityPrefix}/output`,
          role: "program_output",
          version,
          ...(state.outputProjections ?? {}),
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
        {
          response: PortableSchemaDescriptor;
          context?: PortableSchemaDescriptor;
          contextContract?: PortableSchemaDescriptor;
        }
      > = {};
      for (const [key, definition] of Object.entries(normalizedElicits)) {
        const response = toPortableSchema(definition.response, {
          identity: `${identityPrefix}/elicits/${key}/response`,
          role: "elicit_response",
          version,
        });
        catalog.push(response.entry);
        let context;
        if (definition.context) {
          context = toPortableSchema(definition.context, {
            identity: `${identityPrefix}/elicits/${key}/context`,
            role: "elicit_context",
            version,
          });
          catalog.push(context.entry);
        }
        const declaration = {
          response: response.descriptor,
          ...(context ? { context: context.descriptor, contextContract: context.descriptor } : {}),
        };
        manifestElicits[key] = declaration;
      }

      // Effect schema catalog entries travel with their authored definitions;
      // the manifest embeds only their descriptors. Sampling always adds the
      // one canonical contract and its built-in validators.
      const declaredEffects: EffectMap = {
        ...state.effects,
        ...(state.samples ? { [MODEL_SAMPLE_EFFECT.name]: MODEL_SAMPLE_EFFECT } : {}),
      };
      for (const definition of Object.values(declaredEffects)) {
        if (definition === MODEL_SAMPLE_EFFECT) {
          catalog.push(...MODEL_SAMPLE_SCHEMA_ENTRIES);
        } else {
          catalog.push(...effectCatalogEntries(definition));
        }
      }
      const manifest = {
        programId: state.name,
        version,
        inputSchema: input.descriptor,
        outputSchema: outputDescriptor,
        elicits: manifestElicits,
        effects: declaredEffects,
        capabilities: {
          durableEmissions: true,
          structuredChildren: true,
          replay: "strict" as const,
        },
      };
      const factory = (rawInput: Json, context: DurableProgramContext) =>
        program(
          rawInput,
          contextForDeclarations(
            context,
            manifestElicits,
            state.samples === true,
            state.extensions ?? {},
          ),
        );
      const extensionIdentity = sortStrings(Object.keys(state.extensions ?? {})).map((alias) => {
        const extension = state.extensions![alias]!;
        return { alias, name: extension.name, digest: extension.digest };
      });
      const bindExtensions = (baseDigest: string) =>
        extensionIdentity.length === 0
          ? baseDigest
          : stableTupleHash([
              "sweatpants.durable-extension-program.v1",
              { baseDigest, extensions: extensionIdentity },
            ]);
      const generatedIdentity = (implementationArtifactDigest: string) =>
        generateProgramArtifactIdentity({
          format: PROGRAM_ARTIFACT_IDENTITY_FORMAT,
          generatorVersion: PROGRAM_ARTIFACT_GENERATOR_VERSION,
          manifest,
          implementationArtifactDigest: bindExtensions(implementationArtifactDigest),
          resourcePackageDigests: [...(state.resourcePackageDigests ?? [])],
        });
      const tool = state.identity
        ? createLowLevelDurableTool(
            { ...manifest, digest: bindExtensions(state.identity.digest) },
            factory,
          )
        : state.implementationArtifactDigest
          ? createGeneratedPinnedDurableProgram(
              generatedIdentity(state.implementationArtifactDigest),
              factory,
            )
          : extensionIdentity.length > 0
            ? createGeneratedPinnedDurableProgram(
                generatedIdentity(sha256("sweatpants.durable-extension-client.v1")),
                factory,
              )
            : createInterfaceDerivedPinnedDurableProgram(manifest, factory);
      const contractArtifacts = buildToolSchemaArtifacts({
        identity: `tool:${state.name}`,
        version,
        parameters,
        ...(state.parametersProjections
          ? { parametersProjections: state.parametersProjections }
          : {}),
        ...(state.output ? { output: state.output } : {}),
        ...(state.outputProjections ? { outputProjections: state.outputProjections } : {}),
        elicits: normalizedElicits,
      });
      const catalogByDigest = new Map(
        [...catalog, ...contractArtifacts.catalog].map((entry) => [entry.descriptor.digest, entry]),
      );
      const artifacts: ToolSchemaArtifacts = Object.freeze({
        parameters: contractArtifacts.parameters,
        ...(contractArtifacts.output ? { output: contractArtifacts.output } : {}),
        elicits: contractArtifacts.elicits,
        catalog: Object.freeze([...catalogByDigest.values()]),
      });
      const interfaceDigest = computeToolInterfaceDigest({
        name: state.name,
        parameters: artifacts.parameters,
        ...(artifacts.output ? { output: artifacts.output } : {}),
        elicits: artifacts.elicits,
        annotations: {},
        extensions: [],
      });
      const bindings = compileToolInteractionBindings({
        ownerInterfaceDigest: interfaceDigest,
        elicits: normalizedElicits,
        artifacts: artifacts.elicits,
      });
      return Object.freeze({
        ...tool,
        execution: "crank_native" as const,
        name: state.name,
        description,
        parameters,
        ...(state.output ? { output: state.output } : {}),
        elicits: normalizedElicits,
        samples: Object.freeze({}),
        artifacts,
        capabilities: Object.freeze({
          elicitation: Object.keys(normalizedElicits).length > 0,
          sampling: state.samples === true,
        }),
        annotations: Object.freeze({}),
        extensions: Object.freeze([]),
        interfaceDigest,
        bindings,
      });
    },
  };
}

function contextForDeclarations(
  context: DurableProgramContext,
  elicits: Record<
    string,
    {
      response: PortableSchemaDescriptor;
      context?: PortableSchemaDescriptor;
      contextContract?: PortableSchemaDescriptor;
    }
  >,
  sampling: boolean,
  extensions: DurableExtensionMap,
): DurableProgramContext {
  const clients = new Map<unknown, ReturnType<DurableExtensionMap[string]["createClient"]>>(
    Object.values(extensions).map((extension) => [extension, extension.createClient(context)]),
  );
  const aliases = Object.fromEntries(
    Object.entries(extensions).map(([alias, extension]) => [alias, clients.get(extension)!]),
  );
  const adapted = Object.freeze({
    ...context,
    ...aliases,
    use(extension: unknown) {
      const client = clients.get(extension);
      if (!client) {
        throw new CrankError("undeclared_extension", "Durable context extension is not declared");
      }
      return client;
    },
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
    ...(sampling
      ? {
          sample(request: SamplingRequestBase) {
            return sampleModel(context, request);
          },
          sampleTools(
            request: SamplingRequestBase & {
              tools: readonly SamplingTool[];
              toolChoice?: "auto" | "none" | "required";
            },
          ) {
            return sampleModel(context, {
              ...request,
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? null,
                parameters: portableSamplingSchema(tool.inputSchema),
              })),
            });
          },
          sampleSchema<T>(request: SamplingRequestBase & { schema: StandardSchemaV1<unknown, T> }) {
            return sampleStructured(context, request);
          },
        }
      : {}),
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
        declaration.contextContract ?? declaration.context,
      );
    },
  });
  // SAFETY: the adapter preserves the low-level overloads while routing the
  // fluent keyed forms through declared descriptors and default resolvers.
  return adapted as DurableProgramContext;
}

// Canonical request construction preserves authored sampling options at the effect boundary.
// fallow-ignore-next-line complexity
function createCanonicalModelSampleRequest(
  request: SamplingRequestBase & {
    tools?: ChatToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
    schema?: JsonObject;
  },
): ModelSampleRequest {
  const {
    prompt,
    messages,
    tools,
    schema,
    systemPrompt,
    maxTokens,
    modelPreferences,
    classifications,
    toolChoice,
  } = request;
  assertSamplingRequest(prompt, messages, request.retries);
  const contextMessages: ChatMessage[] = [
    ...(systemPrompt !== undefined ? [{ role: "system" as const, content: systemPrompt }] : []),
    ...(prompt === undefined ? [...messages!] : [{ role: "user" as const, content: prompt }]),
  ];
  const context: ModelContext = {
    messages: contextMessages,
    tools: tools ?? [],
  };
  return {
    invocation: {
      context,
      ...(maxTokens !== undefined || toolChoice !== undefined
        ? {
            options: {
              ...(maxTokens !== undefined ? { maxTokens } : {}),
              ...(toolChoice !== undefined ? { toolChoice } : {}),
            },
          }
        : {}),
    },
    tools: tools ? { type: "embedded", tools } : { type: "none" },
    response: schema ? { type: "json", schema } : { type: "message" },
    ...(modelPreferences !== undefined ? { modelPreferences } : {}),
    ...(classifications ? { classifications: [...classifications] } : {}),
  };
}

function* sampleModel(
  context: DurableProgramContext,
  request: SamplingRequestBase & {
    tools?: ChatToolDefinition[];
    toolChoice?: "auto" | "none" | "required";
    schema?: JsonObject;
  },
): Operation<SampleExchangeCompletion> {
  const canonicalRequest = createCanonicalModelSampleRequest(request);
  return projectModelSampleCompletion(
    yield* sampleDurableModel(context, canonicalRequest, { audience: "model-runtime" }),
  );
}

function* sampleStructured<T>(
  context: DurableProgramContext,
  request: SamplingRequestBase & { schema: StandardSchemaV1<unknown, T> },
): Operation<ParsedSampleExchangeCompletion<T> & { parsed: T }> {
  const { schema, retries = 0, ...base } = request;
  assertSamplingRequest(base.prompt, base.messages, retries);
  let lastMessage = "model sample did not satisfy schema";
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = yield* sampleModel(context, {
      ...base,
      schema: portableSamplingSchema(schema),
    });
    const candidate = "parsed" in result ? result.parsed : result.text;
    const validated = validateAuthoredSchema<T>(schema, candidate);
    if (validated.status === "schema-error") {
      lastMessage = `schema ${validated.reason} while checking model output`;
      continue;
    }
    if (validated.status === "ok") {
      return {
        text: result.text,
        ...(result.model !== undefined ? { model: result.model } : {}),
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        parsed: validated.value,
      };
    }
    lastMessage = safeSchemaIssues(validated.issues)
      .slice(0, 4)
      .map((issue) => issue.message)
      .join("; ")
      .slice(0, 512);
  }
  const error = new Error(`Model sample schema validation failed: ${lastMessage}`) as Error & {
    code: string;
  };
  error.code = "schema_validation_failed";
  throw error;
}

function assertSamplingRequest(
  prompt: string | undefined,
  messages: readonly ChatMessage[] | undefined,
  retries = 0,
): void {
  if ((prompt === undefined) === (messages === undefined)) {
    throw new Error("Durable sampling requires exactly one of prompt or messages");
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 10) {
    throw new Error("Durable sampling retries must be an integer between 0 and 10");
  }
}

function portableSamplingSchema(
  schema: StandardSchemaV1 | Readonly<Record<string, unknown>>,
): JsonObject {
  if (isStandardSchemaValue(schema)) {
    if (schema["~standard"].vendor !== "zod") {
      throw new CrankError(
        "schema_projection_unavailable",
        "Durable sampling requires an explicit portable projection for non-Zod schemas",
      );
    }
    try {
      return z.toJSONSchema(schema as z.ZodType) as JsonObject;
    } catch {
      throw new CrankError(
        "schema_projection_unavailable",
        "Durable sampling schema must provide a portable JSON Schema projection",
      );
    }
  }
  return schema as JsonObject;
}

function isStandardSchemaValue(value: unknown): value is StandardSchemaV1 {
  if (!value || typeof value !== "object" || !("~standard" in value)) return false;
  const standard = (value as { "~standard"?: { version?: unknown; validate?: unknown } })[
    "~standard"
  ];
  return Boolean(standard && standard.version === 1 && typeof standard.validate === "function");
}

function normalizeElicits(
  elicits: ElicitsMap,
): Record<string, ElicitDefinition<StandardSchemaV1, StandardSchemaV1 | undefined>> {
  return Object.fromEntries(
    Object.entries(elicits).map(([key, entry]) => {
      const definition: ElicitDefinition<StandardSchemaV1, StandardSchemaV1 | undefined> =
        isElicitDefinition(entry) ? { ...entry } : { response: entry as StandardSchemaV1 };
      if (definition.response === undefined) {
        throw new Error(`Durable tool elicit "${key}" is missing a response schema`);
      }
      return [key, definition];
    }),
  );
}

function isElicitDefinition(
  value: unknown,
): value is ElicitDefinition<StandardSchemaV1, StandardSchemaV1> {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { safeParse?: unknown }).safeParse !== "function" &&
    !("~standard" in (value as object)) &&
    "response" in value,
  );
}

function requireStage<T>(value: T, required: string, attempted: string): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`Durable tool builder: ${required} must be called before ${attempted}`);
  }
  return value as NonNullable<T>;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new Error(`Durable tool builder: ${field} must be non-empty`);
  }
}
