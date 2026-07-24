import { assertJson } from "./canonical.ts";
import {
  createPortableSchemaDescriptor,
  type PortableSchemaDescriptor,
  type PortableSchemaRole,
} from "./schema-descriptor.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { DurableSchemaRegistryEntry } from "./schema-registry.ts";
import type { EffectDefinition } from "./durable-types.ts";
import type { Json } from "./types.ts";

export type ModelSampleCall = {
  id: string;
  target: string;
  input: Json;
  thoughtSignature?: string;
} & Json;

export type ModelSampleRequest = {
  messages: Json[];
  systemPrompt?: Json;
  maxTokens?: number;
  modelPreferences?: Json;
  classifications?: Json[];
  sampling?: Json;
  tools?: Json[];
  toolChoice?: Json;
  schema?: Json;
} & Json;

export type ModelSampleResult = {
  text: string;
  calls: ModelSampleCall[];
  content: Json[];
  model?: string;
  stopReason?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Json }>;
  parsed?: Json;
  parseError?: { message: string; rawText: string };
} & Json;

export type ModelSampleCancellationPartial = {
  text: string;
  interrupted: true;
} & Json;

const schemaEntries: DurableSchemaRegistryEntry[] = [];

function schema(
  identity: string,
  role: PortableSchemaRole,
  projection: Json,
  guard: (value: unknown) => string | undefined,
): PortableSchemaDescriptor {
  const descriptor = createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
  schemaEntries.push({
    descriptor,
    schema: standardSchema((value) => {
      const message = guard(value);
      if (message !== undefined) return { issues: [{ message }] };
      try {
        return { value: assertJson(value) };
      } catch {
        return { issues: [{ message: "value must be canonical JSON" }] };
      }
    }),
  });
  return descriptor;
}

function standardSchema(
  validate: (value: unknown) => StandardSchemaV1.Result<unknown>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "sweatpants", validate } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export const MODEL_SAMPLE_INPUT_DESCRIPTOR = schema(
  "sweatpants.model-sample/input",
  "effect_input",
  {
    type: "object",
    required: ["messages"],
    properties: {
      messages: { type: "array", items: true },
      systemPrompt: true,
      maxTokens: { type: "integer", minimum: 1 },
      modelPreferences: true,
      classifications: { type: "array", items: true },
      sampling: true,
      tools: { type: "array", items: true },
      toolChoice: true,
      schema: true,
    },
    additionalProperties: false,
  },
  (value) => {
    if (!isObject(value) || !Array.isArray(value["messages"])) {
      return "model sample request requires messages";
    }
    const allowed = new Set([
      "messages",
      "systemPrompt",
      "maxTokens",
      "modelPreferences",
      "classifications",
      "sampling",
      "tools",
      "toolChoice",
      "schema",
    ]);
    if (!Object.keys(value).every((key) => allowed.has(key))) {
      return "model sample request has unexpected keys";
    }
    if (
      value["maxTokens"] !== undefined &&
      (!Number.isSafeInteger(value["maxTokens"]) || (value["maxTokens"] as number) < 1)
    ) {
      return "maxTokens must be a positive integer";
    }
    if (value["tools"] !== undefined && !Array.isArray(value["tools"])) {
      return "tools must be an array";
    }
    return undefined;
  },
);

export const MODEL_SAMPLE_OUTPUT_DESCRIPTOR = schema(
  "sweatpants.model-sample/output",
  "effect_output",
  {
    type: "object",
    required: ["text", "calls", "content"],
    properties: {
      text: { type: "string" },
      calls: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "target", "input"],
          properties: {
            id: { type: "string", minLength: 1 },
            target: { type: "string", minLength: 1 },
            input: true,
            thoughtSignature: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      content: { type: "array", items: true },
      model: { type: "string" },
      stopReason: { type: "string" },
      toolCalls: { type: "array", items: true },
      parsed: true,
      parseError: {
        type: "object",
        required: ["message", "rawText"],
        properties: { message: { type: "string" }, rawText: { type: "string" } },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  (value) => {
    if (!isObject(value)) return "model sample result must be an object";
    if (typeof value["text"] !== "string") return "text must be a string";
    if (!Array.isArray(value["calls"]) || !Array.isArray(value["content"])) {
      return "calls and content must be arrays";
    }
    for (const call of value["calls"]) {
      if (
        !isObject(call) ||
        typeof call["id"] !== "string" ||
        call["id"].length === 0 ||
        typeof call["target"] !== "string" ||
        call["target"].length === 0 ||
        !("input" in call)
      ) {
        return "calls entries must be {id, target, input}";
      }
    }
    return undefined;
  },
);

export const MODEL_SAMPLE_PARTIAL_DESCRIPTOR = schema(
  "sweatpants.model-sample/cancellation-partial",
  "effect_cancellation_partial",
  {
    type: "object",
    required: ["text", "interrupted"],
    properties: {
      text: { type: "string", maxLength: 32_768 },
      interrupted: { const: true },
    },
    additionalProperties: false,
  },
  (value) =>
    isObject(value) &&
    typeof value["text"] === "string" &&
    value["text"].length <= 32_768 &&
    value["interrupted"] === true &&
    Object.keys(value).length === 2
      ? undefined
      : "cancellation partial must be { text, interrupted: true }",
);

const definition: EffectDefinition<
  ModelSampleRequest,
  ModelSampleResult,
  ModelSampleCancellationPartial
> = {
  name: "model.sample",
  version: "2",
  inputSchema: MODEL_SAMPLE_INPUT_DESCRIPTOR,
  outputSchema: MODEL_SAMPLE_OUTPUT_DESCRIPTOR,
  cancellation: { partialSchema: MODEL_SAMPLE_PARTIAL_DESCRIPTOR },
  retrySafety: { mode: "repeatable" },
};

/** One canonical repeatable sampling contract used by every authored program. */
export const MODEL_SAMPLE_EFFECT = Object.freeze(definition);
export const MODEL_SAMPLE_SCHEMA_ENTRIES: readonly DurableSchemaRegistryEntry[] = Object.freeze([
  ...schemaEntries,
]);
