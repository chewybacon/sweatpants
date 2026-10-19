import {
  documentEffect,
  documentElicitContextSchema,
  type ElicitDocumentBindings,
} from "./documents.ts";
import {
  MODEL_DECISION_EFFECT,
  MODEL_DECISION_SCHEMA_ENTRIES,
  decisionBindingSchema,
  decisionRequestSchema,
  validateDecisionResult,
  type DecisionBinding,
  type DecisionRequest,
  type DecisionResult,
} from "@sweatpants/model-decision";
import {
  decodeModelSampleResult,
  MODEL_SAMPLE_CONTRACT,
  MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
  MODEL_SAMPLE_PULL_SCHEMA_ENTRIES,
  ModelContextSourceStagerContext,
  type ModelSampleRequest,
  type ModelSampleSourceRequest,
} from "@sweatpants/model-sampling";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";
import type { ModelContext } from "@sweatpants/model-provider";
import type { EffectDefinition } from "@sweatpants/durable-effects";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Operation } from "effection";
import { z } from "zod";
import {
  assertJson,
  sha256,
  sortStrings,
  stableTupleHash,
  type Json,
  type JsonObject,
} from "@sweatpants/foundation";
import { safeSchemaIssues, validateAuthoredSchema } from "@sweatpants/foundation/parser";
import {
  ANY_JSON_SCHEMA_DESCRIPTOR,
  CrankError,
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
import type { SchemaBinding, PortableSchemaDescriptor } from "@sweatpants/foundation/schema";

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

type JsonCompatible<T> = [T] extends [Json]
  ? true
  : [T] extends [null | boolean | number | string | undefined]
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
/** Inferred object unions may contain absent optional properties. */
type JsonResultCompatible<T> = [T] extends [Json]
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends readonly (infer Item)[]
      ? JsonResultCompatible<Item>
      : T extends object
        ? false extends {
            [Key in keyof T]-?: JsonResultCompatible<
              {} extends Pick<T, Key> ? Exclude<T[Key], undefined> : T[Key]
            >;
          }[keyof T]
          ? false
          : true
        : false;

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
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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

type ElicitRequestFor<E> = (ExtractElicitContextInput<E> extends undefined
  ? { message: string }
  : { message: string; context: ExtractElicitContextInput<E> }) &
  ElicitDocumentBindings<E>;

/** Typed durable program context bound to declared effects and elicitations. */
export type DurableProgramContextFor<
  E extends EffectMap,
  TElicits extends ElicitsMap = {},
  TSamples extends boolean = false,
  TExtensions extends DurableExtensionMap = {},
  TDecisions extends boolean = false,
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
  DurableExtensionContext<TExtensions> &
  (TDecisions extends true
    ? { decision(request: DecisionRequest): Operation<DecisionResult> }
    : {});

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
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects, false>;
  samples(): CreateDurableToolBuilderReady<N, I, O, E, {}, true>;
  decisions(
    binding: DecisionBinding,
  ): CreateDurableToolBuilderReady<N, I, O, E, {}, false, {}, true>;
  uses<Extensions extends DurableExtensionMap>(
    extensions: Extensions,
  ): CreateDurableToolBuilderReady<N, I, O, E, {}, false, Extensions>;
  execute<Result extends O extends Json ? O : unknown>(
    program: (
      input: I,
      context: DurableProgramContextFor<{}, E, false>,
    ) => Operation<Result> & (false extends JsonResultCompatible<Result> ? never : unknown),
  ): DurableToolDefinition<N, I, O extends Json ? O : JsonOutput<Result>, E>;
}

export interface CreateDurableToolBuilderReady<
  N extends string,
  I extends Json,
  O extends Json | undefined,
  E extends ElicitsMap,
  Effects extends EffectMap,
  Samples extends boolean = false,
  Extensions extends DurableExtensionMap = {},
  Decisions extends boolean = false,
> {
  effects<Next extends EffectMap>(
    effects: Next,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects & Next, Samples, Extensions, Decisions>;
  samples(): CreateDurableToolBuilderReady<N, I, O, E, Effects, true, Extensions, Decisions>;
  decisions(
    binding: DecisionBinding,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects, Samples, Extensions, true>;
  uses<Next extends DurableExtensionMap>(
    extensions: Next,
  ): CreateDurableToolBuilderReady<N, I, O, E, Effects, Samples, Extensions & Next, Decisions>;
  execute<Result extends O extends Json ? O : unknown>(
    program: (
      input: I,
      context: DurableProgramContextFor<Effects, E, Samples, Extensions, Decisions>,
    ) => Operation<Result> & (false extends JsonResultCompatible<Result> ? never : unknown),
  ): DurableToolDefinition<N, I, O extends Json ? O : JsonOutput<Result>, E>;
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
  decisions?: DecisionBinding;
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
    /* CONDITIONAL-SPREAD: Omit absent implementationArtifactDigest from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
    ...(options.implementationArtifactDigest
      ? { implementationArtifactDigest: options.implementationArtifactDigest }
      : {}),
    /* CONDITIONAL-SPREAD: Omit absent resourcePackageDigests from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
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
        parametersProjections: projections ?? state.parametersProjections,
      });
    },
    output(output: StandardSchemaV1, projections?: SchemaProjectionOptions) {
      requireStage(state.parameters, ".parameters()", ".output()");
      return builder({
        ...state,
        output,
        outputProjections: projections ?? state.outputProjections,
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
      if (effects[MODEL_SAMPLE_CONTRACT.name]) {
        throw new Error("model.sample is a pull kind; declare sampling with .samples()");
      }
      return builder({ ...state, effects: { ...state.effects, ...effects } });
    },
    decisions(binding: DecisionBinding) {
      requireStage(state.parameters, ".parameters()", ".decisions()");
      if (state.decisions) {
        throw new Error("Decision capability already declared");
      }
      return builder({ ...state, decisions: Object.freeze(decisionBindingSchema.parse(binding)) });
    },
    samples() {
      requireStage(state.parameters, ".parameters()", ".samples()");
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
        ...state.parametersProjections,
      });
      catalog.push(input.entry);
      let outputDescriptor: PortableSchemaDescriptor;
      if (state.output) {
        const output = toPortableSchema(state.output, {
          identity: `${identityPrefix}/output`,
          role: "program_output",
          version,
          ...state.outputProjections,
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
        const contextSchema =
          definition.documents && Object.keys(definition.documents).length > 0
            ? documentElicitContextSchema(definition.context, definition.documents)
            : definition.context;
        if (contextSchema) {
          context = toPortableSchema(contextSchema, {
            identity: `${identityPrefix}/elicits/${key}/context`,
            role: "elicit_context",
            version,
          });
          catalog.push(context.entry);
        }
        const declaration = {
          response: response.descriptor,
          /* CONDITIONAL-SPREAD: Omit absent context, contextContract from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
          ...(context ? { context: context.descriptor, contextContract: context.descriptor } : {}),
        };
        manifestElicits[key] = declaration;
      }

      // Effect schema catalog entries travel with their authored definitions;
      // sampling is a pull kind and contributes only its wire validators.
      const declaredEffects: EffectMap = { ...state.effects };
      if (
        Object.values(normalizedElicits).some(
          (entry) => Object.keys(entry.documents ?? {}).length > 0,
        )
      ) {
        declaredEffects[documentEffect.name] = documentEffect;
      }
      if (state.decisions) {
        if (Object.hasOwn(declaredEffects, MODEL_DECISION_EFFECT.name)) {
          throw new Error("Declare model.decision with .decisions()");
        }
        declaredEffects[MODEL_DECISION_EFFECT.name] = MODEL_DECISION_EFFECT;
        catalog.push(...MODEL_DECISION_SCHEMA_ENTRIES);
      }
      if (state.samples) {
        catalog.push(...MODEL_SAMPLE_PULL_SCHEMA_ENTRIES);
      }
      for (const definition of Object.values(declaredEffects)) {
        catalog.push(...effectCatalogEntries(definition));
      }
      const manifest = {
        programId: state.name,
        version,
        inputSchema: input.descriptor,
        outputSchema: outputDescriptor,
        elicits: manifestElicits,
        effects: declaredEffects,
        /* CONDITIONAL-SPREAD: Only sampling-enabled manifests declare the sample pull contract. */
        ...(state.samples
          ? {
              pulls: {
                sample: {
                  input: MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR,
                  output: MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR,
                },
              },
            }
          : {}),
        capabilities: {
          durableEmissions: true,
          structuredChildren: true,
          replay: "strict" as const,
        },
      };
      const contractArtifacts = buildToolSchemaArtifacts({
        identity: `tool:${state.name}`,
        version,
        parameters,
        parametersProjections: state.parametersProjections,
        output: state.output,
        outputProjections: state.outputProjections,
        elicits: normalizedElicits,
      });
      const catalogByDigest = new Map(
        [...catalog, ...contractArtifacts.catalog].map((entry) => [entry.descriptor.digest, entry]),
      );
      const artifacts: ToolSchemaArtifacts = Object.freeze({
        parameters: contractArtifacts.parameters,
        /* CONDITIONAL-SPREAD: Omit absent output from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
        ...(contractArtifacts.output ? { output: contractArtifacts.output } : {}),
        elicits: contractArtifacts.elicits,
        catalog: Object.freeze([...catalogByDigest.values()]),
      });
      const interfaceDigest = computeToolInterfaceDigest({
        name: state.name,
        parameters: artifacts.parameters,
        /* CONDITIONAL-SPREAD: Omit absent output from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
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
      // The authored contract attaches its own compiled interaction identity:
      // every fluent elicit proposal carries the binding into the journal, so
      // placements and drivers stay mechanics-only.
      const factory = (rawInput: Json, context: DurableProgramContext) =>
        program(
          rawInput,
          contextForDeclarations(
            context,
            manifestElicits,
            bindings.elicits,
            state.samples === true,
            state.extensions ?? {},
            state.decisions,
            normalizedElicits,
          ),
        );
      const extensionIdentity = sortStrings(Object.keys(state.extensions ?? {})).map((alias) => {
        const extension = state.extensions![alias];
        return { alias, name: extension.name, digest: extension.digest };
      });
      const bindExtensions = (baseDigest: string) =>
        extensionIdentity.length === 0 && !state.decisions
          ? baseDigest
          : stableTupleHash([
              "sweatpants.durable-extension-program.v1",
              {
                baseDigest,
                extensions: extensionIdentity,
                /* CONDITIONAL-SPREAD: Omit absent decisions from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
                ...(state.decisions ? { decisions: state.decisions } : {}),
              },
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
          : extensionIdentity.length > 0 || state.decisions
            ? createGeneratedPinnedDurableProgram(
                generatedIdentity(sha256("sweatpants.durable-extension-client.v1")),
                factory,
              )
            : createInterfaceDerivedPinnedDurableProgram(manifest, factory);
      return Object.freeze({
        ...tool,
        execution: "crank_native" as const,
        name: state.name,
        description,
        parameters,
        /* CONDITIONAL-SPREAD: Omit absent output from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
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
  bindings: ToolInteractionBindings["elicits"],
  sampling: boolean,
  extensions: DurableExtensionMap,
  decisions?: DecisionBinding,
  authoredElicits: Record<
    string,
    ElicitDefinition<StandardSchemaV1, StandardSchemaV1 | undefined>
  > = {},
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
    /* CONDITIONAL-SPREAD: Expose decision only when its backing capability exists; callers inspect supported methods. */
    ...(decisions
      ? {
          *decision(request: DecisionRequest): Operation<DecisionResult> {
            const checked = decisionRequestSchema.parse(request);
            const result = yield* context.effect(
              MODEL_DECISION_EFFECT,
              { binding: decisions, request: checked },
              { audience: "effect:model.decision" },
            );
            return validateDecisionResult(checked, result);
          },
        }
      : {}),
    use(extension: unknown) {
      const client = clients.get(extension);
      if (!client) {
        throw new CrankError("undeclared_extension", "Durable context extension is not declared");
      }
      return client;
    },
    effect(
      definition: EffectDefinition<Json, Json, Json>,
      input: Json,
      resolver?: { audience: string; route?: string },
    ) {
      return context.effect(
        definition,
        input,
        resolver ?? { audience: `effect:${definition.name}` },
      );
    },
    /* CONDITIONAL-SPREAD: Omit absent sample, sampleTools, sampleSchema from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
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
    *elicit(
      key: string,
      requestOrMessage:
        | {
            message: string;
            context?: Json;
            documents?: Record<string, { id: string; sinceRevision?: number }>;
          }
        | string,
      response?: PortableSchemaDescriptor,
      rawContext?: Json,
    ) {
      // Low-level escape hatch: (key, message, descriptor, context).
      if (typeof requestOrMessage === "string") {
        return yield* context.pull(
          assertJson({
            kind: "elicit",
            key,
            message: requestOrMessage,
            response: response!,
            /* CONDITIONAL-SPREAD: Omit absent context from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
            ...(rawContext === undefined ? {} : { context: rawContext }),
          }),
        );
      }
      const declaration = elicits[key];
      const binding = bindings[key];
      if (!declaration || !binding) {
        throw new Error(`Durable tool elicit "${key}" is not declared`);
      }
      const authored = authoredElicits[key];
      let wireContext = requestOrMessage.context;
      const slots = authored?.documents ?? {};
      if (Object.keys(slots).length > 0) {
        if (
          sortStrings(Object.keys(requestOrMessage.documents ?? {})).join("\0") !==
          sortStrings(Object.keys(slots)).join("\0")
        ) {
          throw new Error("Elicitation document slots do not match declaration");
        }
        if (authored?.context) {
          const checked = validateAuthoredSchema(authored.context, requestOrMessage.context);
          if (checked.status !== "ok") {
            throw new Error("Invalid elicitation context");
          }
        }
        const documents: Record<string, Json> = {};
        for (const [slot, schema] of Object.entries(slots)) {
          const ref = requestOrMessage.documents![slot]!;
          const result = yield* context.effect(
            documentEffect,
            {
              operation: "read",
              document: { id: ref.id },
              /* CONDITIONAL-SPREAD: Omit absent sinceRevision from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(ref.sinceRevision === undefined ? {} : { sinceRevision: ref.sinceRevision }),
            },
            { audience: `effect:${documentEffect.name}` },
          );
          if (result.status !== "ok") {
            throw new Error(`Cannot bind document: ${result.status}`);
          }
          const checked = validateAuthoredSchema(schema, result.observation.current.content);
          if (checked.status !== "ok") {
            throw new Error(`Document does not match slot ${slot}`);
          }
          documents[slot] = assertJson(result.observation);
        }
        wireContext = { context: requestOrMessage.context ?? null, documents };
      }
      return yield* context.pull(
        assertJson({
          kind: "elicit",
          key,
          message: requestOrMessage.message,
          response: declaration.response,
          /* CONDITIONAL-SPREAD: Omit absent context from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
          ...(wireContext === undefined ? {} : { context: wireContext }),
          /* CONDITIONAL-SPREAD: Omit absent contextContract from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
          ...((declaration.contextContract ?? declaration.context)
            ? { contextContract: declaration.contextContract ?? declaration.context }
            : {}),
          binding,
        }),
      );
    },
  });
  // SAFETY: the adapter preserves the low-level overloads while routing the
  // fluent keyed forms through declared descriptors and default resolvers.
  return adapted as unknown as DurableProgramContext;
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
    temperature,
    topP,
    topK,
    thinking,
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
      /* CONDITIONAL-SPREAD: Omit absent options from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
      ...(maxTokens !== undefined ||
      toolChoice !== undefined ||
      temperature !== undefined ||
      topP !== undefined ||
      topK !== undefined ||
      thinking !== undefined
        ? {
            options: {
              /* CONDITIONAL-SPREAD: Omit absent maxTokens from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(maxTokens !== undefined ? { maxTokens } : {}),
              /* CONDITIONAL-SPREAD: Omit absent toolChoice from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(toolChoice !== undefined ? { toolChoice } : {}),
              /* CONDITIONAL-SPREAD: Omit absent temperature from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(temperature !== undefined ? { temperature } : {}),
              /* CONDITIONAL-SPREAD: Omit absent topP from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(topP !== undefined ? { topP } : {}),
              /* CONDITIONAL-SPREAD: Omit absent topK from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(topK !== undefined ? { topK } : {}),
              /* CONDITIONAL-SPREAD: Omit absent thinking from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
              ...(thinking !== undefined ? { thinking } : {}),
            },
          }
        : {}),
    },
    tools: tools ? { type: "embedded", tools } : { type: "none" },
    response: schema ? { type: "json", schema } : { type: "message" },
    /* CONDITIONAL-SPREAD: Omit absent modelPreferences from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
    ...(modelPreferences !== undefined ? { modelPreferences } : {}),
    /* CONDITIONAL-SPREAD: Omit absent classifications from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
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
  const stage = yield* ModelContextSourceStagerContext.get();
  let wireRequest: ModelSampleRequest | ModelSampleSourceRequest = canonicalRequest;
  if (stage) {
    const source = yield* stage(canonicalRequest.invocation.context);
    wireRequest = {
      ...canonicalRequest,
      invocation: {
        context: source,
        /* CONDITIONAL-SPREAD: Omit absent options from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
        ...(canonicalRequest.invocation.options === undefined
          ? {}
          : { options: canonicalRequest.invocation.options }),
      },
    };
  }
  const settled = yield* context.pull({
    kind: "sample",
    input: assertJson(wireRequest),
  });
  return projectModelSampleCompletion(decodeModelSampleResult(settled));
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
    // A parse failure uses null as a sentinel; it is not a valid nullable response.
    if (!("parsed" in result) || result.parseError !== undefined) {
      lastMessage =
        "parsed" in result
          ? (result.parseError?.message ?? "model sample did not produce JSON")
          : "model sample did not produce JSON";
      continue;
    }
    const validated = validateAuthoredSchema<T>(schema, result.parsed);
    if (validated.status === "schema-error") {
      lastMessage = `schema ${validated.reason} while checking model output`;
      continue;
    }
    if (validated.status === "ok") {
      return {
        text: result.text,
        /* CONDITIONAL-SPREAD: Omit absent model from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
        ...(result.model !== undefined ? { model: result.model } : {}),
        /* CONDITIONAL-SPREAD: Omit absent stopReason from portable tool contracts and invocation payloads; explicit undefined is not a portable JSON value. */
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
  if (!value || typeof value !== "object" || !("~standard" in value)) {
    return false;
  }
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
