import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assertJson, type Json, type JsonObject } from "@sweatpants/foundation";
import { createPortableSchemaDescriptor, type SchemaBinding } from "@sweatpants/foundation/schema";
import type {
  EffectDefinition,
  EffectSchemaDescriptor,
  EffectSchemaRole,
} from "@sweatpants/durable-effects/contract";
import type {
  PortableAssistantMessage,
  PortableGenerationOptions,
  PortableModelContextMessage,
  PortableModelTool,
} from "@sweatpants/model-provider";
import { z } from "zod";

export type ModelToolSource =
  | ({ type: "none" } & JsonObject)
  | ({ type: "embedded"; tools: PortableModelTool[] } & JsonObject)
  | ({ type: "catalog"; digest: string } & JsonObject);

export type ModelResponseMode =
  | ({ type: "message" } & JsonObject)
  | ({ type: "json"; schema: JsonObject; name?: string | undefined } & JsonObject);

/** Thin durable wrapper around provider-owned portable model semantics. */
export type ModelSampleInvocationOptions = Omit<PortableGenerationOptions, "responseFormat">;

export type ModelSampleRequest = {
  invocation: {
    context: {
      messages: PortableModelContextMessage[];
      systemPrompt?: string;
    };
    options?: ModelSampleInvocationOptions;
  };
  tools: ModelToolSource;
  response: ModelResponseMode;
  /** Opaque until the deployment's model-selection policy consumes it. */
  modelPreferences?: Json;
  /** Opaque placement and authorization facts. */
  classifications?: Json[];
} & JsonObject;

export type ModelSampleOutput =
  | ({ type: "message" } & JsonObject)
  | ({ type: "json"; value: Json } & JsonObject)
  | ({ type: "json-invalid"; error: { message: string; rawText: string } } & JsonObject);

export type ModelSampleResult = {
  message: PortableAssistantMessage;
  output: ModelSampleOutput;
} & JsonObject;

export type ModelSampleCancellationPartial = {
  text: string;
  interrupted: true;
} & JsonObject;

const schemaEntries: SchemaBinding[] = [];

function descriptor(identity: string, role: EffectSchemaRole, projection: Json) {
  return createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
}

function bindSchema<T extends Json>(
  identity: string,
  role: EffectSchemaRole,
  projection: Json,
  validator: StandardSchemaV1<unknown, T>,
): EffectSchemaDescriptor {
  const value = descriptor(identity, role, projection);
  schemaEntries.push({ descriptor: value, schema: validator });
  return value;
}

const idSchema = z.string().min(1).max(4_096);
const textSchema = z.string().max(8 * 1024 * 1024);
const jsonObjectSchema = z.record(z.string(), z.json());

const portableToolCallSchema = z.strictObject({
  id: idSchema,
  type: z.literal("function"),
  function: z.strictObject({ name: idSchema, arguments: z.json() }),
  thoughtSignature: textSchema.optional(),
});

const inputBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: textSchema,
    textSignature: textSchema.optional(),
  }),
  z.strictObject({ type: z.literal("image"), data: textSchema, mimeType: idSchema }),
]);

const assistantBlockSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: textSchema,
    textSignature: textSchema.optional(),
  }),
  z.strictObject({ type: z.literal("image"), data: textSchema, mimeType: idSchema }),
  z.strictObject({
    type: z.literal("thinking"),
    text: textSchema,
    format: idSchema.optional(),
    thinkingSignature: textSchema.optional(),
    redacted: z.boolean().optional(),
  }),
  z.strictObject({ type: z.literal("toolCall"), toolCall: portableToolCallSchema }),
]);

const contextMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("system"), content: textSchema }),
  z.strictObject({
    role: z.literal("user"),
    content: z.union([textSchema, z.array(inputBlockSchema).max(100_000)]),
  }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.array(assistantBlockSchema).max(100_000),
  }),
  z.strictObject({
    role: z.literal("tool"),
    tool_call_id: idSchema,
    name: idSchema,
    content: z.union([textSchema, z.array(inputBlockSchema).max(100_000)]),
    isError: z.boolean(),
  }),
]);

const modelToolSchema = z.strictObject({
  name: idSchema,
  description: textSchema.optional(),
  parameters: jsonObjectSchema,
});

const generationOptionsSchema = z.strictObject({
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  maxTokens: z.number().int().positive().safe().optional(),
  temperature: z.number().finite().optional(),
  topP: z.number().finite().optional(),
  topK: z.number().int().safe().optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

const toolSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("embedded"), tools: z.array(modelToolSchema).max(10_000) }),
  z.strictObject({ type: z.literal("catalog"), digest: z.string().regex(/^[0-9a-f]{64}$/u) }),
]);

const responseModeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message") }),
  z.strictObject({ type: z.literal("json"), schema: jsonObjectSchema, name: idSchema.optional() }),
]);

const modelSampleRequestSchema = z.strictObject({
  invocation: z.strictObject({
    context: z.strictObject({
      messages: z.array(contextMessageSchema).max(100_000),
      systemPrompt: textSchema.optional(),
    }),
    options: generationOptionsSchema.optional(),
  }),
  tools: toolSourceSchema,
  response: responseModeSchema,
  modelPreferences: z.json().optional(),
  classifications: z.array(z.json()).max(4_096).optional(),
});

const sourceSchema = z.strictObject({
  api: idSchema,
  provider: idSchema,
  model: idSchema,
  responseModel: idSchema.optional(),
});

const assistantMessageSchema = z.strictObject({
  role: z.literal("assistant"),
  content: z.array(assistantBlockSchema).max(100_000),
  source: sourceSchema.optional(),
  stopReason: idSchema.optional(),
  responseId: idSchema.optional(),
  errorMessage: textSchema.optional(),
});

const modelSampleOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message") }),
  z.strictObject({ type: z.literal("json"), value: z.json() }),
  z.strictObject({
    type: z.literal("json-invalid"),
    error: z.strictObject({ message: textSchema, rawText: textSchema }),
  }),
]);

const modelSampleResultSchema = z.strictObject({
  message: assistantMessageSchema,
  output: modelSampleOutputSchema,
});

const modelSamplePartialSchema = z.strictObject({
  text: z.string().max(32_768),
  interrupted: z.literal(true),
});

function standardSchema(schema: z.ZodType): StandardSchemaV1<unknown, Json> {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants",
      validate(value) {
        const parsed = schema.safeParse(value);
        return parsed.success
          ? { value: assertJson(parsed.data) }
          : {
              issues: parsed.error.issues.map((issue) => ({
                message: issue.message,
                path: issue.path,
              })),
            };
      },
    },
  };
}

const requestProjection = assertJson(z.toJSONSchema(modelSampleRequestSchema));
const resultProjection = assertJson(z.toJSONSchema(modelSampleResultSchema));
const partialProjection = assertJson(z.toJSONSchema(modelSamplePartialSchema));

export const MODEL_SAMPLE_INPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/input",
  "effect_input",
  requestProjection,
  standardSchema(modelSampleRequestSchema),
);

export const MODEL_SAMPLE_OUTPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/output",
  "effect_output",
  resultProjection,
  standardSchema(modelSampleResultSchema),
);

export const MODEL_SAMPLE_PARTIAL_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/cancellation-partial",
  "effect_cancellation_partial",
  partialProjection,
  standardSchema(modelSamplePartialSchema),
);

const definition: EffectDefinition<
  ModelSampleRequest,
  ModelSampleResult,
  ModelSampleCancellationPartial
> = {
  name: "model.sample",
  version: "1",
  inputSchema: MODEL_SAMPLE_INPUT_DESCRIPTOR,
  outputSchema: MODEL_SAMPLE_OUTPUT_DESCRIPTOR,
  cancellation: { partialSchema: MODEL_SAMPLE_PARTIAL_DESCRIPTOR },
  retrySafety: { mode: "repeatable" },
};

export const MODEL_SAMPLE_EFFECT = Object.freeze(definition);
export const MODEL_SAMPLE_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  ...schemaEntries,
]);
