import { assertJson } from "@sweatpants/foundation";
import { z } from "zod";
import { createPortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { SchemaBinding } from "@sweatpants/foundation/schema";
import type { EffectDefinition, EffectSchemaDescriptor, EffectSchemaRole } from "./contract.ts";
import type { Json } from "@sweatpants/foundation";

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

const schemaEntries: SchemaBinding[] = [];

function schema(
  identity: string,
  role: EffectSchemaRole,
  projection: Json,
  guard: (value: unknown) => string | undefined,
): EffectSchemaDescriptor {
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
      if (message !== undefined) {
        return { issues: [{ message }] };
      }
      try {
        return { value: assertJson(value) };
      } catch {
        return { issues: [{ message: "value must be canonical JSON" }] };
      }
    }),
  });
  return descriptor;
}

const modelSampleRequestSchema = z.strictObject({
  messages: z.array(z.json()),
  systemPrompt: z.json().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
  modelPreferences: z.json().optional(),
  classifications: z.array(z.json()).optional(),
  sampling: z.json().optional(),
  tools: z.array(z.json()).optional(),
  toolChoice: z.json().optional(),
  schema: z.json().optional(),
});
const modelSampleResultSchema = z.strictObject({
  text: z.string(),
  calls: z.array(
    z.strictObject({
      id: z.string().min(1),
      target: z.string().min(1),
      input: z.json(),
      thoughtSignature: z.string().optional(),
    }),
  ),
  content: z.array(z.json()),
  model: z.string().optional(),
  stopReason: z.string().optional(),
  toolCalls: z.array(z.json()).optional(),
  parsed: z.json().optional(),
  parseError: z.strictObject({ message: z.string(), rawText: z.string() }).optional(),
});
const modelSamplePartialSchema = z.strictObject({
  text: z.string().max(32_768),
  interrupted: z.literal(true),
});

function standardSchema(
  validate: (value: unknown) => StandardSchemaV1.Result<unknown>,
): StandardSchemaV1 {
  return { "~standard": { version: 1, vendor: "sweatpants", validate } };
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
  (value) =>
    modelSampleRequestSchema.safeParse(value).success
      ? undefined
      : "model sample request structure is invalid",
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
  (value) =>
    modelSampleResultSchema.safeParse(value).success
      ? undefined
      : "model sample result structure is invalid",
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
    modelSamplePartialSchema.safeParse(value).success
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
export const MODEL_SAMPLE_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  ...schemaEntries,
]);
