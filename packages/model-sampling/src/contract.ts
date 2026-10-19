import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  assertJson,
  failure,
  parser,
  success,
  type Json,
  type JsonObject,
  type ParseIssue,
  type ParseResult,
  type Parser,
} from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  type PortableSchemaDescriptor,
  type SchemaBinding,
} from "@sweatpants/foundation/schema";
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

export type ModelContextSource =
  | {
      readonly type: "object";
      readonly object: { readonly objectId: string };
      readonly digest: string;
    }
  | {
      readonly type: "conversation";
      readonly conversationId: string;
      readonly checkpoint: { readonly checkpointId: string };
      readonly acceptedCommandId: string;
      readonly executionId: string;
      readonly taskId: string;
      readonly taskJournalFrontier: string;
      readonly systemPrompt?: string;
      readonly contextArtifact?: { readonly objectId: string };
    };

export interface ModelSampleSourceRequest {
  readonly invocation: {
    readonly context: ModelContextSource;
    readonly options?: ModelSampleInvocationOptions;
  };
  readonly tools: ModelToolSource;
  readonly response: ModelResponseMode;
  readonly modelPreferences?: Json;
  readonly classifications?: Json[];
}

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

export type ModelSampleWireRequest = JsonObject;
type ModelSampleWireResult = JsonObject;

const MAX_MODEL_SAMPLE_MESSAGES = 4_096;
const MAX_MODEL_SAMPLE_TOOLS = 1_024;
const MAX_MODEL_SAMPLE_CLASSIFICATIONS = 1_024;

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
  z.strictObject({
    type: z.literal("embedded"),
    tools: z.array(z.unknown()).max(MAX_MODEL_SAMPLE_TOOLS),
  }),
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
const modelContextSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("object"),
    object: z.strictObject({ objectId: z.string().min(1).max(512) }),
    digest: z.string().min(1).max(512),
  }),
  z.strictObject({
    type: z.literal("conversation"),
    conversationId: z.string().min(1).max(512),
    checkpoint: z.strictObject({ checkpointId: z.string().min(1).max(512) }),
    acceptedCommandId: z.string().min(1).max(512),
    executionId: z.string().min(1).max(1024),
    taskId: z.string().min(1).max(512),
    taskJournalFrontier: z.string().min(1).max(512),
    systemPrompt: z
      .string()
      .max(64 * 1024)
      .optional(),
    contextArtifact: z.strictObject({ objectId: z.string().min(1).max(512) }).optional(),
  }),
]);
const modelSampleRequestSchema = z.strictObject({
  invocation: z.strictObject({ context: z.unknown(), options: optionsSchema.optional() }),
  tools: toolSourceSchema,
  response: responseModeSchema,
  modelPreferences: z.json().optional(),
  classifications: z.array(z.json()).max(MAX_MODEL_SAMPLE_CLASSIFICATIONS).optional(),
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
  // The response parser below validates and owns the complete message.
  message: z.unknown(),
  output: modelSampleOutputSchema,
});
const modelSampleCancellationPartialSchema = z.strictObject({
  text: z.string().min(1),
  interrupted: z.literal(true),
});

// Check collection sizes before walking message bodies. The same limits apply
// when a trusted context is assembled from a journal rather than decoded.
const modelContextBoundsParser = parser(
  z.looseObject({ messages: z.unknown(), tools: z.unknown() }).superRefine((context, issues) => {
    for (const [key, limit] of [
      ["messages", MAX_MODEL_SAMPLE_MESSAGES],
      ["tools", MAX_MODEL_SAMPLE_TOOLS],
    ] as const) {
      const values = context[key];
      if (Array.isArray(values) && values.length > limit) {
        issues.addIssue({ code: "custom", path: [key], message: `${key} count exceeds ${limit}` });
      }
    }
  }),
);
const boundedModelContextParser = modelContextBoundsParser.andThen((value) =>
  modelContextParser.parse(value),
);
const modelSampleRequestStructureParser =
  parser(modelSampleRequestSchema).andThen(parseRequestTools);
const modelSampleSourceRequestSchema = modelSampleRequestSchema.extend({
  invocation: z.strictObject({
    context: modelContextSourceSchema,
    options: optionsSchema.optional(),
  }),
});
const modelContextSourceParser = parser(modelContextSourceSchema);
const modelSampleSourceRequestParser = parser(modelSampleSourceRequestSchema).andThen(
  parseRequestTools,
);

function parseRequestTools<T extends { tools: z.infer<typeof toolSourceSchema> }>(
  value: T,
): ParseResult<Omit<T, "tools"> & { tools: ModelToolSource }> {
  if (value.tools.type !== "embedded") {
    return success({ ...value, tools: value.tools });
  }
  const tools: ChatToolDefinition[] = [];
  for (const [index, tool] of value.tools.tools.entries()) {
    const parsed = chatToolDefinitionParser.parse(tool);
    if (!parsed.ok) {
      return prefixFailure(parsed.issues, ["tools", "tools", index]);
    }
    tools.push(parsed.value);
  }
  return success({ ...value, tools: { type: "embedded" as const, tools } });
}
const modelSampleResultStructureParser = parser(modelSampleResultSchema);

/** Result-oriented parser for one model-sampling request. */
export const modelSampleRequestParser: Parser<ModelSampleRequest> =
  modelSampleRequestStructureParser.andThen((value) => {
    const context = boundedModelContextParser.parse(value.invocation.context);
    if (!context.ok) {
      return prefixFailure(context.issues, ["invocation", "context"]);
    }
    return success({
      invocation: { context: context.value, options: value.invocation.options },
      tools: value.tools,
      response: value.response,
      modelPreferences: value.modelPreferences,
      classifications: value.classifications,
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

export function decodeModelContextSource(value: unknown): ModelContextSource {
  return requireParsed(modelContextSourceParser, value, "$", "invalid model context source");
}

export function decodeModelSampleSourceRequest(value: unknown): ModelSampleSourceRequest {
  return requireParsed(
    modelSampleSourceRequestParser,
    value,
    "$",
    "invalid model sampling source request",
  );
}

export function resolveModelSampleSourceRequest(
  request: ModelSampleSourceRequest,
  context: ModelContext,
): ModelSampleRequest {
  requireParsed(modelContextBoundsParser, context, "$.invocation.context", "invalid model context");
  return {
    ...request,
    invocation: {
      context,
      options: request.invocation.options,
    },
  };
}

export function encodeModelSampleSourceRequest(
  request: ModelSampleSourceRequest,
): ModelSampleWireRequest {
  return JSON.parse(JSON.stringify(request)) as JsonObject;
}

export function encodeModelSampleRequest(request: ModelSampleRequest): ModelSampleWireRequest {
  return JSON.parse(JSON.stringify(request)) as JsonObject;
}

export function decodeModelSampleResult(value: unknown): ModelSampleResult {
  return requireParsed(modelSampleResultParser, value, "$", "invalid model sampling result");
}

export function encodeModelSampleResult(result: ModelSampleResult): ModelSampleWireResult {
  return JSON.parse(
    JSON.stringify({ message: result.message, output: result.output }),
  ) as JsonObject;
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

function bindPullSchema<T>(
  identity: string,
  role: "pull_input" | "pull_output",
  projection: Json,
  valueParser: Parser<T>,
  encode: (value: T) => Json,
): PortableSchemaDescriptor {
  const value = createPortableSchemaDescriptor({
    identity,
    role,
    version: "1",
    vendor: "sweatpants",
    inputProjection: projection,
    outputProjection: projection,
    fidelity: { input: "explicit", output: "explicit" },
  });
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
  modelSampleSourceRequestParser,
  (value) => encodeModelSampleSourceRequest(value),
);

export const MODEL_SAMPLE_OUTPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/output",
  "effect_output",
  objectProjection,
  modelSampleResultParser,
  (value) => encodeModelSampleResult(value),
);

/** Pull-contract descriptors for workflow-native model sampling. */
export const MODEL_SAMPLE_PULL_INPUT_DESCRIPTOR = bindPullSchema(
  "sweatpants.model-sample/pull-input",
  "pull_input",
  objectProjection,
  modelSampleSourceRequestParser,
  (value) => encodeModelSampleSourceRequest(value),
);

export const MODEL_SAMPLE_PULL_OUTPUT_DESCRIPTOR = bindPullSchema(
  "sweatpants.model-sample/pull-output",
  "pull_output",
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

export const MODEL_SAMPLE_CONTRACT: EffectDefinition<
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

export const MODEL_SAMPLE_CONTRACT_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze(
  schemaEntries.filter((entry) => !entry.descriptor.role.startsWith("pull_")),
);
export const MODEL_SAMPLE_PULL_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze(
  schemaEntries.filter((entry) => entry.descriptor.role.startsWith("pull_")),
);
