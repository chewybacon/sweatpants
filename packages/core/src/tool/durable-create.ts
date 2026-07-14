import { z, type ZodSchema } from "zod";
import {
  assertJson,
  createDurableTool as createLowLevelDurableTool,
  type DurableProgramContext,
  type DurableProgramGenerator,
  type DurableTool,
  type EffectDefinition,
  type Json,
  type ProgramResume,
  type ProgramStepProposal,
} from "@sweatpants/session-contract";

import type { ElicitDefinition, ElicitsMap } from "./types.ts";

type JsonOutput<T> = T extends Json ? T : never;
type EffectInput<D> = D extends EffectDefinition<infer I, Json, Json> ? I : never;
type EffectOutput<D> = D extends EffectDefinition<Json, infer O, Json> ? O : never;
type EffectMap = Record<string, EffectDefinition<Json, Json, Json>>;
type EffectFromMap<E extends EffectMap> = E[keyof E];

export type DurableProgramContextFor<E extends EffectMap> = Omit<
  DurableProgramContext,
  "effect"
> & {
  effect<D extends EffectFromMap<E>>(
    definition: D,
    input: EffectInput<D>,
    resolver?: { audience: string; route?: string },
  ): Generator<ProgramStepProposal, EffectOutput<D>, ProgramResume>;
};

export type FluentDurableTool<N extends string, I extends Json, O extends Json> = DurableTool<
  I,
  O
> & {
  readonly name: N;
  readonly description: string;
};

export interface CreateDurableToolBuilderBase<N extends string> {
  description(description: string): CreateDurableToolBuilderWithDescription<N>;
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
  ): CreateDurableToolBuilderReady<N, I, O, Effects>;
}

export interface CreateDurableToolBuilderReady<
  N extends string,
  I extends Json,
  O extends Json | undefined,
  Effects extends EffectMap,
> {
  execute<Result extends O extends Json ? O : Json>(
    program: (
      input: I,
      context: DurableProgramContextFor<Effects>,
    ) => DurableProgramGenerator<Result>,
  ): FluentDurableTool<N, I, O extends Json ? O : Result>;
}

type BuilderState = {
  name: string;
  description?: string;
  identity?: { version: string; digest: string };
  parameters?: ZodSchema;
  output?: ZodSchema;
  elicits?: ElicitsMap;
  effects?: EffectMap;
};

/** Creates a type-staged Zod authoring adapter over the low-level durable manifest API. */
export function createDurableTool<N extends string>(name: N): CreateDurableToolBuilderBase<N> {
  return builder({ name }) as CreateDurableToolBuilderBase<N>;
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
      requireStage(state.identity, ".identity()", ".parameters()");
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
      requireStage(state.identity, ".identity()", ".execute()");
      requireStage(state.parameters, ".parameters()", ".execute()");
      requireStage(state.effects, ".effects()", ".execute()");
      const identity = state.identity!;
      const description = state.description!;
      const manifest = {
        programId: state.name,
        version: identity.version,
        digest: identity.digest,
        inputSchema: jsonSchema(state.parameters!),
        outputSchema: state.output ? jsonSchema(state.output) : true,
        elicits: durableElicits(state.elicits ?? {}),
        effects: state.effects!,
        capabilities: {
          durableEmissions: true,
          structuredChildren: true,
          replay: "strict" as const,
        },
      };
      const tool = createLowLevelDurableTool(
        manifest,
        (input: Json, context: DurableProgramContext) => program(input, contextForEffects(context)),
      );
      return Object.freeze({ ...tool, name: state.name, description });
    },
  };
}

function contextForEffects(context: DurableProgramContext): DurableProgramContext {
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
  });
  // SAFETY: the adapter preserves both low-level overloads and only adds a
  // default resolver for the definition-based fluent form.
  return adapted as DurableProgramContext;
}

function durableElicits(elicits: ElicitsMap) {
  return Object.fromEntries(
    Object.entries(elicits).map(([key, entry]) => {
      const definition: ElicitDefinition<ZodSchema, ZodSchema | undefined> = isElicitDefinition(
        entry,
      )
        ? entry
        : { response: entry };
      return [
        key,
        {
          responseSchema: jsonSchema(definition.response),
          ...(definition.context ? { contextSchema: jsonSchema(definition.context) } : {}),
        },
      ];
    }),
  );
}

function isElicitDefinition(value: unknown): value is ElicitDefinition<ZodSchema, ZodSchema> {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { safeParse?: unknown }).safeParse !== "function" &&
    "response" in value,
  );
}

function jsonSchema(schema: ZodSchema): Json {
  return assertJson(z.toJSONSchema(schema));
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
