import { z } from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { validateAuthoredSchema } from "@sweatpants/foundation/parser";
import type { SchemaProjectionOptions } from "./types.ts";
import { toPortableSchema } from "../schema/zod-adapter.ts";
import { assertJson, type Json, type JsonObject } from "@sweatpants/foundation";
import type { Handler, IterableOperation } from "@sweatpants/foundation/computation";
import type { RetryMode } from "@sweatpants/foundation/journal";
import { buildToolSchemaArtifacts } from "./artifacts.ts";
import { computeToolInterfaceDigest, type ToolSchemaArtifacts } from "./contract.ts";
import {
  compileToolInteractionBindings,
  type ToolInteractionBindings,
} from "./interaction-binding.ts";

export type Effects = Record<
  string,
  {
    version: string;
    input: StandardSchemaV1;
    output: StandardSchemaV1;
    inputProjections?: SchemaProjectionOptions;
    outputProjections?: SchemaProjectionOptions;
    retrySafety: { mode: RetryMode };
  }
>;
export type Elicits = Record<
  string,
  {
    response: StandardSchemaV1;
    context?: StandardSchemaV1;
    responseProjections?: SchemaProjectionOptions;
    contextProjections?: SchemaProjectionOptions;
    documents?: never;
  }
>;
export type JournalRequest =
  | {
      kind: "nested-sample";
      tool: string;
      callId: string;
      prompt: string;
      maxTokens: number;
      schema: JsonObject | null;
    }
  | {
      kind: "log";
      tool: string;
      callId: string;
      level: "debug" | "info" | "warning" | "error";
      message: string;
    }
  | { kind: "progress"; tool: string; callId: string; message: string; progress: number }
  | {
      kind: "effect";
      tool: string;
      callId: string;
      key: string;
      version: string;
      input: Json;
      retrySafety: { mode: RetryMode };
    }
  | { kind: "elicit"; tool: string; callId: string; key: string; message: string; context: Json };
type Answer<T> = { action: "accept"; content: T } | { action: "decline" } | { action: "cancel" };
export interface JournalToolContext<E extends Effects, L extends Elicits, Y = JournalRequest> {
  sample(input: {
    prompt: string;
    maxTokens?: number;
    schema?: JsonObject;
  }): IterableOperation<{ text: string }, Y>;
  log(level: "debug" | "info" | "warning" | "error", message: string): IterableOperation<void, Y>;
  notify(message: string, progress?: number): IterableOperation<void, Y>;
  effect<K extends keyof E & string>(
    key: K,
    input: StandardSchemaV1.InferInput<E[K]["input"]>,
  ): IterableOperation<StandardSchemaV1.InferOutput<E[K]["output"]>, Y>;
  elicit<K extends keyof L & string>(
    key: K,
    input: { message: string; context?: StandardSchemaV1.InferInput<NonNullable<L[K]["context"]>> },
  ): IterableOperation<Answer<StandardSchemaV1.InferOutput<L[K]["response"]>>, Y>;
}

/** Tool bodies are deterministic JSON-yielding iterators. Native I/O belongs in handlers. */
export function compileJournalTool<
  P extends StandardSchemaV1,
  O extends StandardSchemaV1,
  E extends Effects,
  L extends Elicits,
>(definition: {
  name: string;
  description: string;
  parameters: P;
  output?: O;
  parametersProjections?: SchemaProjectionOptions;
  outputProjections?: SchemaProjectionOptions;
  version: string;
  sampling?: boolean;
  effects: E;
  elicits: L;
  execute(
    input: StandardSchemaV1.InferOutput<P>,
    context: JournalToolContext<E, L>,
  ): IterableOperation<StandardSchemaV1.InferInput<O>, JournalRequest>;
}): CompiledJournalTool<P, O, E, L> {
  for (const elicit of Object.values(definition.elicits)) {
    if ("documents" in elicit) {
      throw new Error("Journal tool elicitation documents are unsupported");
    }
  }
  for (const [key, effect] of Object.entries(definition.effects)) {
    for (const side of ["input", "output"] as const) {
      toPortableSchema(effect[side], {
        identity: `tool:${definition.name}/effects/${key}/${side}`,
        role: `effect_${side}`,
        version: effect.version,
        ...effect[`${side}Projections`],
      });
    }
  }
  const artifacts = buildToolSchemaArtifacts({
    identity: `tool:${definition.name}`,
    version: definition.version,
    parameters: definition.parameters,
    parametersProjections: definition.parametersProjections,
    outputProjections: definition.outputProjections,
    output: definition.output,
    elicits: definition.elicits,
  });
  const interfaceDigest = computeToolInterfaceDigest({ name: definition.name, ...artifacts });
  const bindings = compileToolInteractionBindings({
    ownerInterfaceDigest: interfaceDigest,
    elicits: Object.fromEntries(Object.keys(definition.elicits).map((key) => [key, {}])),
    artifacts: artifacts.elicits,
  });
  return Object.freeze({
    ...definition,
    artifacts,
    interfaceDigest,
    bindings,
    samples: {},
    capabilities: {
      elicitation: Object.keys(definition.elicits).length > 0,
      sampling: definition.sampling ?? false,
    },
    annotations: {},
    extensions: [],
    *invoke(argumentsValue: unknown, callId: string): IterableOperation<Json, JournalRequest> {
      const context = createJournalToolContext(definition, callId, function* (request) {
        return yield request;
      });
      const result = yield* definition.execute(
        validateJournalValue(definition.parameters, argumentsValue),
        context,
      );
      return assertJson(
        definition.output ? validateJournalValue(definition.output, result) : result,
      );
    },
  });
}

/** Project a request handler into the schema-checked tool authoring context. */
export function createJournalToolContext<E extends Effects, L extends Elicits, Y>(
  definition: { name: string; effects: E; elicits: L },
  callId: string,
  dispatch: Handler<JournalRequest, Y>,
): JournalToolContext<E, L, Y> {
  return {
    *sample(input) {
      return (yield* dispatch({
        kind: "nested-sample",
        tool: definition.name,
        callId,
        prompt: input.prompt,
        maxTokens: input.maxTokens ?? 1024,
        schema: input.schema ?? null,
      })) as { text: string };
    },
    *log(level, message) {
      yield* dispatch({ kind: "log", tool: definition.name, callId, level, message });
    },
    *notify(message, progress = 0) {
      yield* dispatch({ kind: "progress", tool: definition.name, callId, message, progress });
    },
    *effect(key, input) {
      const effect = definition.effects[key];
      if (!(key in definition.effects)) {
        throw new Error(`Unknown effect: ${key}`);
      }
      validateJournalValue(effect.input, input);
      const value = yield* dispatch({
        kind: "effect",
        tool: definition.name,
        callId,
        key,
        version: effect.version,
        // Keep the wire input raw: the host validates it into handler input.
        input: assertJson(input),
        retrySafety: effect.retrySafety,
      });
      return validateJournalValue(effect.output, value);
    },
    *elicit(key, input) {
      const elicit = definition.elicits[key];
      if (!(key in definition.elicits)) {
        throw new Error(`Unknown elicitation: ${key}`);
      }
      if (elicit.context) {
        validateJournalValue(elicit.context, input.context);
      }
      const value = yield* dispatch({
        kind: "elicit",
        tool: definition.name,
        callId,
        key,
        message: input.message,
        // Clients apply the authored context transform once, against raw wire input.
        context: elicit.context ? assertJson(input.context) : null,
      });
      return parseJournalAnswer(elicit.response, value);
    },
  };
}

/** Synchronous Standard Schema validation shared by the compiler and hosts. */
export function validateJournalValue<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): StandardSchemaV1.InferOutput<S> {
  const checked = validateAuthoredSchema<StandardSchemaV1.InferOutput<S>>(schema, value);
  if (checked.status !== "ok") {
    throw new Error(`Journal schema validation failed: ${JSON.stringify(checked)}`);
  }
  return checked.value;
}

export function parseJournalAnswer<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Answer<StandardSchemaV1.InferOutput<S>> {
  const answer = z
    .discriminatedUnion("action", [
      z.strictObject({ action: z.literal("accept"), content: z.unknown() }),
      z.strictObject({ action: z.literal("decline") }),
      z.strictObject({ action: z.literal("cancel") }),
    ])
    .parse(value);
  if (answer.action === "accept") {
    if (!Object.hasOwn(answer, "content")) {
      throw new Error("Accepted answer requires content");
    }
    const content = validateJournalValue(schema, answer.content);
    assertJson(content);
    return { action: "accept", content };
  }
  return answer;
}

/** Compiled host contract; independent of the authoring entrypoint. */
export interface JournalTool {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly parameters: StandardSchemaV1;
  readonly output?: StandardSchemaV1;
  readonly effects: Effects;
  readonly elicits: Elicits;
  readonly artifacts: ToolSchemaArtifacts;
  readonly interfaceDigest: string;
  readonly bindings: ToolInteractionBindings;
  readonly samples: {};
  readonly capabilities: { elicitation: boolean; sampling: boolean };
  readonly annotations: {};
  readonly extensions: readonly never[];
  invoke(input: unknown, callId: string): IterableOperation<Json, JournalRequest>;
}

export interface CompiledJournalTool<
  P extends StandardSchemaV1,
  O extends StandardSchemaV1,
  E extends Effects,
  L extends Elicits,
> extends JournalTool {
  readonly parameters: P;
  readonly output?: O;
  readonly effects: E;
  readonly elicits: L;
}
