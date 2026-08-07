import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  assertJson,
  failure,
  parser,
  success,
  type Json,
  type JsonObject,
  type ParseIssue,
  type Parser,
} from "@sweatpants/foundation";
import { createPortableSchemaDescriptor, type SchemaBinding } from "@sweatpants/foundation/schema";
import type {
  EffectDefinition,
  EffectSchemaDescriptor,
  EffectSchemaRole,
  SerializedEffectError,
} from "@sweatpants/durable-effects/contract";
import { chatToolDefinitionParser, type ChatToolDefinition } from "@sweatpants/chat-contract";
import {
  modelContextParser,
  modelResponseParser,
  type ModelContext,
  type ModelGenerationOptions,
  type ModelResponse,
} from "@sweatpants/model-provider";
import { z } from "zod";

export type ModelToolSource =
  | { type: "none" }
  | { type: "embedded"; tools: ChatToolDefinition[] }
  | { type: "catalog"; digest: string };

export type ModelResponseMode =
  | { type: "message" }
  | { type: "json"; schema: JsonObject; name?: string };

export type ModelSampleInvocationOptions = Omit<ModelGenerationOptions, "responseFormat">;

/** Decoded canonical model-sampling command used by services and planners. */
export interface ModelSampleRequest {
  readonly invocation: {
    readonly context: ModelContext;
    readonly options?: ModelSampleInvocationOptions;
  };
  readonly tools: ModelToolSource;
  readonly response: ModelResponseMode;
  readonly modelPreferences?: Json;
  readonly classifications?: Json[];
}

export type ModelSampleOutput =
  | { type: "message" }
  | { type: "json"; value: Json }
  | { type: "json-invalid"; error: { message: string; rawText: string } };

export interface ModelSampleResult {
  readonly message: ModelResponse;
  readonly output: ModelSampleOutput;
}

export type ModelSampleCancellationPartial = {
  text: string;
  interrupted: true;
} & JsonObject;

export type ModelSampleDisposition =
  | { readonly status: "ok"; readonly value: ModelSampleResult }
  | { readonly status: "error"; readonly error: SerializedEffectError }
  | { readonly status: "cancelled"; readonly partial?: ModelSampleCancellationPartial };

type ModelSampleWireRequest = JsonObject;
type ModelSampleWireResult = JsonObject;

const optionsSchema = z.strictObject({
  toolChoice: z.enum(["auto", "none", "required"]).optional(),
  maxTokens: z.number().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});
const toolSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("embedded"), tools: z.array(z.json()) }),
  z.strictObject({ type: z.literal("catalog"), digest: z.string().min(1) }),
]);
const responseModeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message") }),
  z.strictObject({
    type: z.literal("json"),
    schema: z.record(z.string(), z.json()),
    name: z.string().optional(),
  }),
]);
const modelSampleRequestSchema = z.strictObject({
  invocation: z.strictObject({ context: z.json(), options: optionsSchema.optional() }),
  tools: toolSourceSchema,
  response: responseModeSchema,
  modelPreferences: z.json().optional(),
  classifications: z.array(z.json()).optional(),
});
const modelSampleOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message") }),
  z.strictObject({ type: z.literal("json"), value: z.json() }),
  z.strictObject({
    type: z.literal("json-invalid"),
    error: z.strictObject({ message: z.string().min(1), rawText: z.string().min(1) }),
  }),
]);
const modelSampleResultSchema = z.strictObject({
  message: z.json(),
  output: modelSampleOutputSchema,
});
const modelSampleCancellationPartialSchema = z.strictObject({
  text: z.string().min(1),
  interrupted: z.literal(true),
});

const modelSampleRequestStructureParser = parser(modelSampleRequestSchema);
const modelSampleResultStructureParser = parser(modelSampleResultSchema);

/** Result-oriented parser for one model-sampling request. */
export const modelSampleRequestParser: Parser<ModelSampleRequest> =
  modelSampleRequestStructureParser.andThen((value) => {
    const context = modelContextParser.parse(value.invocation.context);
    if (!context.ok) {
      return prefixFailure(context.issues, ["invocation", "context"]);
    }

    let tools: ModelToolSource;
    if (value.tools.type === "embedded") {
      const parsedTools: ChatToolDefinition[] = [];
      for (const [index, tool] of value.tools.tools.entries()) {
        const parsedTool = chatToolDefinitionParser.parse(tool);
        if (!parsedTool.ok) {
          return prefixFailure(parsedTool.issues, ["tools", "tools", index]);
        }
        parsedTools.push(parsedTool.value);
      }
      tools = { type: "embedded", tools: parsedTools };
    } else {
      tools = value.tools;
    }

    return success({
      invocation: {
        context: context.value,
        ...(value.invocation.options === undefined
          ? {}
          : { options: normalizeOptions(value.invocation.options) }),
      },
      tools,
      response: value.response as ModelResponseMode,
      ...(value.modelPreferences === undefined ? {} : { modelPreferences: value.modelPreferences }),
      ...(value.classifications === undefined ? {} : { classifications: value.classifications }),
    });
  });

/** Result-oriented parser for one model-sampling result. */
export const modelSampleResultParser: Parser<ModelSampleResult> =
  modelSampleResultStructureParser.andThen((value) => {
    const message = modelResponseParser.parse(value.message);
    if (!message.ok) {
      return prefixFailure(message.issues, ["message"]);
    }
    return success({ message: message.value, output: value.output });
  });

/** Result-oriented parser for one model-sampling cancellation partial. */
export const modelSampleCancellationPartialParser: Parser<ModelSampleCancellationPartial> = parser(
  modelSampleCancellationPartialSchema,
).map((value) => value as ModelSampleCancellationPartial);

export function decodeModelSampleRequest(value: unknown): ModelSampleRequest {
  return requireParsed(modelSampleRequestParser, value, "$", "invalid model sampling request");
}

export function encodeModelSampleRequest(request: ModelSampleRequest): ModelSampleWireRequest {
  return assertJson({
    invocation: {
      context: request.invocation.context,
      ...(request.invocation.options === undefined ? {} : { options: request.invocation.options }),
    },
    tools: request.tools,
    response: request.response,
    ...(request.modelPreferences === undefined
      ? {}
      : { modelPreferences: request.modelPreferences }),
    ...(request.classifications === undefined ? {} : { classifications: request.classifications }),
  }) as JsonObject;
}

export function decodeModelSampleResult(value: unknown): ModelSampleResult {
  return requireParsed(modelSampleResultParser, value, "$", "invalid model sampling result");
}

export function encodeModelSampleResult(result: ModelSampleResult): ModelSampleWireResult {
  return assertJson({ message: result.message, output: result.output }) as JsonObject;
}

function normalizeOptions(value: z.output<typeof optionsSchema>): ModelSampleInvocationOptions {
  return {
    ...(value.toolChoice === undefined ? {} : { toolChoice: value.toolChoice }),
    ...(value.maxTokens === undefined ? {} : { maxTokens: value.maxTokens }),
    ...(value.temperature === undefined ? {} : { temperature: value.temperature }),
    ...(value.topP === undefined ? {} : { topP: value.topP }),
    ...(value.topK === undefined ? {} : { topK: value.topK }),
    ...(value.thinking === undefined ? {} : { thinking: value.thinking }),
  };
}

function requireParsed<T>(
  valueParser: Parser<T>,
  value: unknown,
  path: string,
  fallback: string,
): T {
  const parsed = valueParser.parse(value);
  if (!parsed.ok) {
    throw new TypeError(`${path}: ${parsed.issues[0]?.message ?? fallback}`);
  }
  return parsed.value;
}

function prefixFailure<T = never>(
  issues: readonly ParseIssue[],
  prefix: readonly (string | number)[],
) {
  return failure<T>(
    issues.map((issue) => ({
      ...issue,
      path: [...prefix, ...issue.path],
    })),
  );
}

const schemaEntries: SchemaBinding[] = [];

function descriptor(
  identity: string,
  role: EffectSchemaRole,
  projection: Json,
): EffectSchemaDescriptor {
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

function bindSchema<T>(
  identity: string,
  role: EffectSchemaRole,
  projection: Json,
  valueParser: Parser<T>,
  encode: (value: T) => Json,
): EffectSchemaDescriptor {
  const value = descriptor(identity, role, projection);
  schemaEntries.push({ descriptor: value, schema: parserStandardSchema(valueParser, encode) });
  return value;
}

function parserStandardSchema<T>(
  valueParser: Parser<T>,
  encode: (value: T) => Json,
): StandardSchemaV1<unknown, Json> {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants",
      validate(value) {
        const parsed = valueParser.parse(value);
        if (!parsed.ok) {
          return {
            issues: parsed.issues.map((issue) => ({
              message: issue.message,
              path: issue.path,
            })),
          };
        }
        return { value: encode(parsed.value) };
      },
    },
  };
}

const objectProjection = { type: "object" } as const;

export const MODEL_SAMPLE_INPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/input",
  "effect_input",
  objectProjection,
  modelSampleRequestParser,
  (value) => encodeModelSampleRequest(value),
);

export const MODEL_SAMPLE_OUTPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/output",
  "effect_output",
  objectProjection,
  modelSampleResultParser,
  (value) => encodeModelSampleResult(value),
);

const modelSamplePartialProjection = { type: "object", required: ["text", "interrupted"] };
export const MODEL_SAMPLE_PARTIAL_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/cancellation-partial",
  "effect_cancellation_partial",
  modelSamplePartialProjection,
  modelSampleCancellationPartialParser,
  (value) => assertJson(value),
);

export const MODEL_SAMPLE_EFFECT: EffectDefinition<
  ModelSampleWireRequest,
  ModelSampleWireResult,
  ModelSampleCancellationPartial
> = Object.freeze({
  name: "model.sample",
  version: "1",
  inputSchema: MODEL_SAMPLE_INPUT_DESCRIPTOR,
  outputSchema: MODEL_SAMPLE_OUTPUT_DESCRIPTOR,
  cancellation: { partialSchema: MODEL_SAMPLE_PARTIAL_DESCRIPTOR },
  retrySafety: { mode: "repeatable" as const },
});

export const MODEL_SAMPLE_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  ...schemaEntries,
]);
