import { z } from "zod";
import { assertJson, type Json, type JsonObject } from "@sweatpants/foundation";
import type { IterableOperation } from "@sweatpants/foundation/computation";
import type { RetryMode } from "@sweatpants/foundation/journal";
import { buildToolSchemaArtifacts } from "./tool/artifacts.ts";
import { computeToolInterfaceDigest } from "./tool/contract.ts";
import { compileToolInteractionBindings } from "./tool/interaction-binding.ts";

type Effects = Record<
  string,
  { version: string; input: z.ZodType; output: z.ZodType; retrySafety: { mode: RetryMode } }
>;
type Elicits = Record<string, { response: z.ZodType; context?: z.ZodType }>;
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
export interface JournalToolContext<E extends Effects, L extends Elicits> {
  sample(input: {
    prompt: string;
    maxTokens?: number;
    schema?: JsonObject;
  }): IterableOperation<{ text: string }, JournalRequest>;
  log(
    level: "debug" | "info" | "warning" | "error",
    message: string,
  ): IterableOperation<void, JournalRequest>;
  notify(message: string, progress?: number): IterableOperation<void, JournalRequest>;
  effect<K extends keyof E & string>(
    key: K,
    input: z.input<E[K]["input"]>,
  ): IterableOperation<z.output<E[K]["output"]>, JournalRequest>;
  elicit<K extends keyof L & string>(
    key: K,
    input: { message: string; context?: z.input<NonNullable<L[K]["context"]>> },
  ): IterableOperation<Answer<z.output<L[K]["response"]>>, JournalRequest>;
}

/** Tool bodies are deterministic JSON-yielding iterators. Native I/O belongs in handlers. */
export function defineJournalTool<
  P extends z.ZodType,
  O extends z.ZodType,
  E extends Effects,
  L extends Elicits,
>(definition: {
  name: string;
  description: string;
  parameters: P;
  output?: O;
  version?: string;
  sampling?: boolean;
  effects: E;
  elicits: L;
  execute(
    input: z.output<P>,
    context: JournalToolContext<E, L>,
  ): IterableOperation<z.output<O>, JournalRequest>;
}) {
  const artifacts = buildToolSchemaArtifacts({
    identity: `tool:${definition.name}`,
    version: definition.version ?? "1",
    parameters: definition.parameters,
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
      const context: JournalToolContext<E, L> = {
        *sample(input) {
          return (yield {
            kind: "nested-sample",
            tool: definition.name,
            callId,
            prompt: input.prompt,
            maxTokens: input.maxTokens ?? 1024,
            schema: input.schema ?? null,
          }) as { text: string };
        },
        *log(level, message) {
          yield { kind: "log", tool: definition.name, callId, level, message };
        },
        *notify(message, progress = 0) {
          yield { kind: "progress", tool: definition.name, callId, message, progress };
        },
        *effect(key, input) {
          const effect = definition.effects[key];
          if (!(key in definition.effects)) {
            throw new Error(`Unknown effect: ${key}`);
          }
          const value = yield {
            kind: "effect",
            tool: definition.name,
            callId,
            key,
            version: effect.version,
            input: assertJson(effect.input.parse(input)),
            retrySafety: effect.retrySafety,
          };
          return effect.output.parse(value) as z.output<E[typeof key]["output"]>;
        },
        *elicit(key, input) {
          const elicit = definition.elicits[key];
          if (!(key in definition.elicits)) {
            throw new Error(`Unknown elicitation: ${key}`);
          }
          const value = yield {
            kind: "elicit",
            tool: definition.name,
            callId,
            key,
            message: input.message,
            context: elicit.context ? assertJson(elicit.context.parse(input.context)) : null,
          };
          return parseJournalAnswer(elicit.response, value) as Answer<
            z.output<L[typeof key]["response"]>
          >;
        },
      };
      const result = yield* definition.execute(
        definition.parameters.parse(argumentsValue),
        context,
      );
      return assertJson(definition.output ? definition.output.parse(result) : result);
    },
  });
}

export function parseJournalAnswer(schema: z.ZodType, value: unknown): Answer<unknown> {
  const answer = z
    .discriminatedUnion("action", [
      z.strictObject({ action: z.literal("accept"), content: schema }),
      z.strictObject({ action: z.literal("decline") }),
      z.strictObject({ action: z.literal("cancel") }),
    ])
    .parse(value);
  return answer;
}

export type JournalTool = ReturnType<typeof defineJournalTool>;
