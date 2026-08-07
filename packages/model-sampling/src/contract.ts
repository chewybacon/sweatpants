import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assertJson, requireJsonObject, type Json, type JsonObject } from "@sweatpants/foundation";
import { createPortableSchemaDescriptor, type SchemaBinding } from "@sweatpants/foundation/schema";
import type {
  EffectDefinition,
  EffectSchemaDescriptor,
  EffectSchemaRole,
  SerializedEffectError,
} from "@sweatpants/durable-effects/contract";
import { decodeChatToolDefinition, type ChatToolDefinition } from "@sweatpants/chat-contract";
import {
  decodeModelContext,
  decodeModelResponse,
  type ModelContext,
  type ModelGenerationOptions,
  type ModelResponse,
} from "@sweatpants/model-provider";

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

function bindSchema(
  identity: string,
  role: EffectSchemaRole,
  projection: Json,
  validator: StandardSchemaV1<unknown, Json>,
): EffectSchemaDescriptor {
  const value = descriptor(identity, role, projection);
  schemaEntries.push({ descriptor: value, schema: validator });
  return value;
}

function standardSchema(normalize: (value: unknown) => Json): StandardSchemaV1<unknown, Json> {
  return {
    "~standard": {
      version: 1,
      vendor: "sweatpants",
      validate(value) {
        try {
          return { value: normalize(value) };
        } catch (error) {
          return {
            issues: [
              {
                message: error instanceof Error ? error.message : "invalid model sampling value",
              },
            ],
          };
        }
      },
    },
  };
}

export function decodeModelSampleRequest(value: unknown): ModelSampleRequest {
  const input = object(value, "$");
  const invocation = object(input["invocation"], "$.invocation");
  const context = decodeModelContext(invocation["context"], "$.invocation.context");
  const options = decodeOptions(invocation["options"], "$.invocation.options");
  const tools = decodeToolSource(input["tools"], "$.tools");
  const response = decodeResponseMode(input["response"], "$.response");
  const modelPreferences = hasOwn(input, "modelPreferences")
    ? assertJson(input["modelPreferences"], "$.modelPreferences")
    : undefined;
  const classifications = hasOwn(input, "classifications")
    ? array(input["classifications"], "$.classifications").map((entry, index) =>
        assertJson(entry, `$.classifications[${index}]`),
      )
    : undefined;
  return {
    invocation: {
      context,
      ...(options === undefined ? {} : { options }),
    },
    tools,
    response,
    ...(modelPreferences === undefined ? {} : { modelPreferences }),
    ...(classifications === undefined ? {} : { classifications }),
  };
}

export function encodeModelSampleRequest(request: ModelSampleRequest): ModelSampleWireRequest {
  return object(
    assertJson({
      invocation: {
        context: request.invocation.context,
        ...(request.invocation.options === undefined
          ? {}
          : { options: request.invocation.options }),
      },
      tools: request.tools,
      response: request.response,
      ...(request.modelPreferences === undefined
        ? {}
        : { modelPreferences: request.modelPreferences }),
      ...(request.classifications === undefined
        ? {}
        : { classifications: request.classifications }),
    }),
    "$",
  );
}

export function decodeModelSampleResult(value: unknown): ModelSampleResult {
  const input = object(value, "$");
  const output = decodeOutput(input["output"], "$.output");
  return { message: decodeModelResponse(input["message"], "$.message"), output };
}

export function encodeModelSampleResult(result: ModelSampleResult): ModelSampleWireResult {
  return object(assertJson({ message: result.message, output: result.output }), "$");
}

function decodeOptions(value: unknown, path: string): ModelSampleInvocationOptions | undefined {
  if (value === undefined) return undefined;
  const input = object(value, path);
  assertKeys(input, ["toolChoice", "maxTokens", "temperature", "topP", "topK", "thinking"], path);
  const output: {
    -readonly [Key in keyof ModelSampleInvocationOptions]?: ModelSampleInvocationOptions[Key];
  } = {};
  const toolChoice = input["toolChoice"];
  if (toolChoice !== undefined) {
    if (toolChoice !== "auto" && toolChoice !== "none" && toolChoice !== "required") {
      throw new TypeError(`${path}.toolChoice is invalid`);
    }
    output.toolChoice = toolChoice;
  }
  for (const key of ["maxTokens", "temperature", "topP", "topK"] as const) {
    const item = input[key];
    if (item !== undefined) {
      if (typeof item !== "number" || !Number.isFinite(item))
        throw new TypeError(`${path}.${key} is invalid`);
      output[key] = item;
    }
  }
  const thinking = input["thinking"];
  if (thinking !== undefined) {
    if (
      thinking !== "off" &&
      thinking !== "minimal" &&
      thinking !== "low" &&
      thinking !== "medium" &&
      thinking !== "high" &&
      thinking !== "xhigh"
    ) {
      throw new TypeError(`${path}.thinking is invalid`);
    }
    output.thinking = thinking;
  }
  return output;
}

function decodeToolSource(value: unknown, path: string): ModelToolSource {
  const input = object(value, path);
  const type = requiredString(input, "type", path);
  switch (type) {
    case "none":
      assertKeys(input, ["type"], path);
      return { type };
    case "embedded": {
      assertKeys(input, ["type", "tools"], path);
      return {
        type,
        tools: array(input["tools"], `${path}.tools`).map((entry, index) =>
          decodeChatToolDefinition(entry, `${path}.tools[${index}]`),
        ),
      };
    }
    case "catalog":
      assertKeys(input, ["type", "digest"], path);
      return { type, digest: requiredString(input, "digest", path) };
    default:
      throw new TypeError(`${path}.type is invalid`);
  }
}

function decodeResponseMode(value: unknown, path: string): ModelResponseMode {
  const input = object(value, path);
  const type = requiredString(input, "type", path);
  if (type === "message") {
    assertKeys(input, ["type"], path);
    return { type };
  }
  if (type === "json") {
    assertKeys(input, ["type", "schema", "name"], path);
    const schema = object(input["schema"], `${path}.schema`);
    const name = input["name"];
    if (name !== undefined && typeof name !== "string")
      throw new TypeError(`${path}.name is invalid`);
    return name === undefined ? { type, schema } : { type, schema, name };
  }
  throw new TypeError(`${path}.type is invalid`);
}

function decodeOutput(value: unknown, path: string): ModelSampleOutput {
  const input = object(value, path);
  const type = requiredString(input, "type", path);
  switch (type) {
    case "message":
      assertKeys(input, ["type"], path);
      return { type };
    case "json":
      assertKeys(input, ["type", "value"], path);
      return { type, value: assertJson(input["value"], `${path}.value`) };
    case "json-invalid": {
      assertKeys(input, ["type", "error"], path);
      const error = object(input["error"], `${path}.error`);
      assertKeys(error, ["message", "rawText"], `${path}.error`);
      return {
        type,
        error: {
          message: requiredString(error, "message", `${path}.error`),
          rawText: requiredString(error, "rawText", `${path}.error`),
        },
      };
    }
    default:
      throw new TypeError(`${path}.type is invalid`);
  }
}

function object(value: unknown, path: string): JsonObject {
  return requireJsonObject(assertJson(value, path), path);
}

function array(value: unknown, path: string): Json[] {
  const parsed = assertJson(value, path);
  if (!Array.isArray(parsed)) throw new TypeError(`${path} must be an array`);
  return parsed;
}

function requiredString(input: JsonObject, key: string, path: string): string {
  if (!hasOwn(input, key) || typeof input[key] !== "string" || input[key].length === 0) {
    throw new TypeError(`${path}.${key} must be a non-empty string`);
  }
  return input[key] as string;
}

function assertKeys(input: JsonObject, allowed: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!set.has(key)) throw new TypeError(`${path}.${key} is unknown`);
  }
}

function hasOwn(input: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

const objectProjection = { type: "object" } as const;

export const MODEL_SAMPLE_INPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/input",
  "effect_input",
  objectProjection,
  standardSchema((value) => assertJson(encodeModelSampleRequest(decodeModelSampleRequest(value)))),
);

export const MODEL_SAMPLE_OUTPUT_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/output",
  "effect_output",
  objectProjection,
  standardSchema((value) => assertJson(encodeModelSampleResult(decodeModelSampleResult(value)))),
);

const modelSamplePartialProjection = { type: "object", required: ["text", "interrupted"] };
export const MODEL_SAMPLE_PARTIAL_DESCRIPTOR = bindSchema(
  "sweatpants.model-sample/cancellation-partial",
  "effect_cancellation_partial",
  modelSamplePartialProjection,
  standardSchema((value) => {
    const input = object(value, "$");
    assertKeys(input, ["text", "interrupted"], "$");
    if (input["interrupted"] !== true) throw new TypeError("$.interrupted must be true");
    return assertJson({ text: requiredString(input, "text", "$"), interrupted: true });
  }),
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
