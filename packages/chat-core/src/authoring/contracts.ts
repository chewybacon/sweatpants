import { CrankError } from "@sweatpants/durable-execution";
import {
  failure,
  parser,
  success,
  type Json,
  type JsonObject,
  type Parser,
  cloneJson,
} from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type PortableSchemaDescriptor,
  type SchemaBinding,
} from "@sweatpants/foundation/schema";
import { sortedResourceValues, type DataClassification } from "@sweatpants/agent-sdk";
import { z } from "zod";

export type AuthoredChatContentPart = {
  value: Json;
  provenance: {
    classifications: DataClassification[];
    sourceDigests: string[];
  };
} & JsonObject;
export type AuthoredChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: AuthoredChatContentPart[];
} & JsonObject;
export type AuthoredReferencedTaskSummary = {
  taskId: string;
  summary: AuthoredChatMessage;
} & JsonObject;
export type AuthoredChatContextView = {
  policyDigest: string;
  frontier: string;
  referenceTaskIds: string[];
  referencedTasks: AuthoredReferencedTaskSummary[];
  messages: AuthoredChatMessage[];
  truncation: { omittedMessages: number; omittedReferencedTasks: number };
} & JsonObject;
export type AuthoredChatTurnInput = {
  message: AuthoredChatMessage;
  context: AuthoredChatContextView;
} & JsonObject;
export type AuthoredChatArtifact = {
  id: string;
  name?: string;
  description?: string;
  parts: AuthoredChatContentPart[];
} & JsonObject;
export type AuthoredChatTurnResult = {
  message: AuthoredChatMessage;
  artifacts: AuthoredChatArtifact[];
} & JsonObject;
export type AuthoredChatContextPolicy = {
  id: string;
  maxMessages: number;
  maxReferencedTasks: number;
  maxCanonicalBytes: number;
  digest: string;
} & JsonObject;
export type AuthoredChatModelToolCall = {
  id: string;
  target: string;
  input: Json;
} & JsonObject;
export type AuthoredChatModelSampleRequest = {
  messages: AuthoredChatMessage[];
  systemPrompt: AuthoredChatContentPart;
  tools: Json[];
  classifications: DataClassification[];
  sampling: Json;
} & JsonObject;
export type AuthoredChatModelSampleResult = {
  message: AuthoredChatMessage;
  calls: AuthoredChatModelToolCall[];
  artifacts: AuthoredChatArtifact[];
} & JsonObject;

const textEncoder = new TextEncoder();
const classificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedTextSchema = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => textEncoder.encode(value).byteLength <= maxBytes);
const opaqueIdSchema = boundedTextSchema(512);
const provenanceSchema = z.strictObject({
  classifications: z.array(classificationSchema),
  sourceDigests: z.array(digestSchema),
});
const authoredPartSchema = z.strictObject({ value: z.json(), provenance: provenanceSchema });
const authoredMessageSchema = z.strictObject({
  id: opaqueIdSchema,
  role: z.enum(["user", "assistant", "system", "tool"]),
  parts: z.array(authoredPartSchema),
});
const referencedTaskSchema = z.strictObject({
  taskId: opaqueIdSchema,
  summary: authoredMessageSchema,
});
const authoredContextSchema = z.strictObject({
  policyDigest: digestSchema,
  frontier: opaqueIdSchema,
  referenceTaskIds: z.array(opaqueIdSchema),
  referencedTasks: z.array(referencedTaskSchema),
  messages: z.array(authoredMessageSchema),
  truncation: z.strictObject({
    omittedMessages: z.number().int().nonnegative(),
    omittedReferencedTasks: z.number().int().nonnegative(),
  }),
});
const authoredArtifactSchema = z.strictObject({
  id: opaqueIdSchema,
  name: boundedTextSchema(512).optional(),
  description: boundedTextSchema(4_096).optional(),
  parts: z.array(authoredPartSchema),
});
const authoredTurnInputSchema = z.strictObject({
  message: authoredMessageSchema,
  context: authoredContextSchema,
});
const authoredTurnResultSchema = z.strictObject({
  message: authoredMessageSchema,
  artifacts: z.array(authoredArtifactSchema),
});
const modelToolCallSchema = z.strictObject({
  id: opaqueIdSchema,
  target: opaqueIdSchema,
  input: z.json(),
});
const authoredModelSampleRequestSchema = z.strictObject({
  messages: z.array(authoredMessageSchema),
  systemPrompt: authoredPartSchema,
  tools: z.array(z.json()),
  classifications: z.array(classificationSchema),
  sampling: z.json(),
});
const authoredModelSampleResultSchema = z.strictObject({
  message: authoredMessageSchema,
  calls: z.array(modelToolCallSchema),
  artifacts: z.array(authoredArtifactSchema),
});

type StructuralPart = z.output<typeof authoredPartSchema>;
type StructuralMessage = z.output<typeof authoredMessageSchema>;
type StructuralContext = z.output<typeof authoredContextSchema>;
type StructuralArtifact = z.output<typeof authoredArtifactSchema>;
type StructuralTurnInput = z.output<typeof authoredTurnInputSchema>;
type StructuralTurnResult = z.output<typeof authoredTurnResultSchema>;
type StructuralModelRequest = z.output<typeof authoredModelSampleRequestSchema>;
type StructuralModelResult = z.output<typeof authoredModelSampleResultSchema>;

export const authoredChatContentPartParser: Parser<AuthoredChatContentPart> = parser(
  authoredPartSchema,
).andThen((value) => semanticResult(() => normalizePart(value)));
export const authoredChatMessageParser: Parser<AuthoredChatMessage> = parser(
  authoredMessageSchema,
).andThen((value) => semanticResult(() => normalizeMessage(value)));
export const authoredChatTurnInputParser: Parser<AuthoredChatTurnInput> = parser(
  authoredTurnInputSchema,
).andThen((value) => semanticResult(() => normalizeTurnInput(value)));
export const authoredChatTurnResultParser: Parser<AuthoredChatTurnResult> = parser(
  authoredTurnResultSchema,
).andThen((value) => semanticResult(() => normalizeTurnResult(value)));
export const authoredChatModelSampleRequestParser: Parser<AuthoredChatModelSampleRequest> = parser(
  authoredModelSampleRequestSchema,
).andThen((value) => semanticResult(() => normalizeModelSampleRequest(value)));
export const authoredChatModelSampleResultParser: Parser<AuthoredChatModelSampleResult> = parser(
  authoredModelSampleResultSchema,
).andThen((value) => semanticResult(() => normalizeModelSampleResult(value)));

const inputDescriptor = descriptor("sweatpants.chat-turn/input", "program_input", {
  type: "object",
  required: ["message", "context"],
  properties: { message: true, context: true },
  additionalProperties: false,
});
const resultDescriptor = descriptor("sweatpants.chat-turn/result", "program_output", {
  type: "object",
  required: ["message", "artifacts"],
  properties: { message: true, artifacts: { type: "array" } },
  additionalProperties: false,
});
export const CHAT_TURN_INPUT_DESCRIPTOR = inputDescriptor;
export const CHAT_TURN_RESULT_DESCRIPTOR = resultDescriptor;
const authoredModelSampleInputDescriptor = descriptor(
  "sweatpants.chat-model-sample/input",
  "effect_input",
  {
    type: "object",
    required: ["messages", "systemPrompt", "tools", "classifications", "sampling"],
    additionalProperties: false,
  },
);
const authoredModelSampleOutputDescriptor = descriptor(
  "sweatpants.chat-model-sample/output",
  "effect_output",
  {
    type: "object",
    required: ["message", "calls", "artifacts"],
    additionalProperties: false,
  },
);
export const AUTHORED_MODEL_SAMPLE_INPUT_DESCRIPTOR = authoredModelSampleInputDescriptor;
export const AUTHORED_MODEL_SAMPLE_OUTPUT_DESCRIPTOR = authoredModelSampleOutputDescriptor;

export const CHAT_CONTRACT_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  entry(inputDescriptor, authoredChatTurnInputParser),
  entry(resultDescriptor, authoredChatTurnResultParser),
  entry(authoredModelSampleInputDescriptor, authoredChatModelSampleRequestParser),
  entry(authoredModelSampleOutputDescriptor, authoredChatModelSampleResultParser),
]);

export function parseAuthoredChatTurnInput(value: unknown): AuthoredChatTurnInput {
  return requireParsed(authoredChatTurnInputParser, value, "invalid chat turn input");
}
export function parseAuthoredChatTurnResult(value: unknown): AuthoredChatTurnResult {
  return requireParsed(authoredChatTurnResultParser, value, "invalid chat turn result");
}
export function parseAuthoredChatMessage(value: unknown): AuthoredChatMessage {
  return requireParsed(authoredChatMessageParser, value, "invalid chat message");
}
export function parseAuthoredContentPart(value: unknown): AuthoredChatContentPart {
  return requireParsed(authoredChatContentPartParser, value, "invalid content part");
}
export function parseAuthoredChatModelSampleRequest(
  value: unknown,
): AuthoredChatModelSampleRequest {
  return requireParsed(authoredChatModelSampleRequestParser, value, "invalid model sample input");
}
export function parseAuthoredChatModelSampleResult(value: unknown): AuthoredChatModelSampleResult {
  return requireParsed(authoredChatModelSampleResultParser, value, "invalid model sample output");
}

function normalizeTurnInput(input: StructuralTurnInput): AuthoredChatTurnInput {
  return snapshot({
    message: normalizeMessage(input.message),
    context: normalizeContext(input.context),
  });
}
function normalizeTurnResult(result: StructuralTurnResult): AuthoredChatTurnResult {
  const ids = new Set<string>();
  const artifacts = result.artifacts.map((artifact) => {
    const parsed = normalizeArtifact(artifact);
    if (ids.has(parsed.id)) {
      invalid("duplicate artifact ID");
    }
    ids.add(parsed.id);
    return parsed;
  });
  return snapshot({ message: normalizeMessage(result.message), artifacts });
}
function normalizeMessage(message: StructuralMessage): AuthoredChatMessage {
  return snapshot({
    id: message.id,
    role: message.role,
    parts: message.parts.map(normalizePart),
  });
}
function normalizeContext(context: StructuralContext): AuthoredChatContextView {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const id of context.referenceTaskIds) {
    if (!seen.has(id)) {
      seen.add(id);
      references.push(id);
    }
  }
  return snapshot({
    policyDigest: context.policyDigest,
    frontier: context.frontier,
    referenceTaskIds: references,
    referencedTasks: context.referencedTasks.map((task) => ({
      taskId: task.taskId,
      summary: normalizeMessage(task.summary),
    })),
    messages: context.messages.map(normalizeMessage),
    truncation: context.truncation,
  });
}
function normalizeArtifact(artifact: StructuralArtifact): AuthoredChatArtifact {
  return snapshot({
    id: artifact.id,
    ...(artifact.name === undefined ? {} : { name: artifact.name }),
    ...(artifact.description === undefined ? {} : { description: artifact.description }),
    parts: artifact.parts.map(normalizePart),
  });
}
function normalizePart(part: StructuralPart): AuthoredChatContentPart {
  const classifications = uniqueSorted(part.provenance.classifications);
  const sourceDigests = uniqueSorted(part.provenance.sourceDigests);
  if (
    classifications.length !== part.provenance.classifications.length ||
    sourceDigests.length !== part.provenance.sourceDigests.length ||
    classifications.some((value, index) => value !== part.provenance.classifications[index]) ||
    sourceDigests.some((value, index) => value !== part.provenance.sourceDigests[index])
  ) {
    invalid("provenance must be sorted and duplicate-free");
  }
  return snapshot({
    value: cloneJson(part.value),
    provenance: { classifications, sourceDigests },
  });
}
function normalizeModelSampleRequest(
  input: StructuralModelRequest,
): AuthoredChatModelSampleRequest {
  return snapshot({
    messages: input.messages.map(normalizeMessage),
    systemPrompt: normalizePart(input.systemPrompt),
    tools: input.tools.map((tool) => cloneJson(tool)),
    classifications: input.classifications,
    sampling: cloneJson(input.sampling),
  });
}
function normalizeModelSampleResult(output: StructuralModelResult): AuthoredChatModelSampleResult {
  const callIds = new Set<string>();
  const calls = output.calls.map((call) => {
    if (callIds.has(call.id)) {
      invalid("duplicate model tool call ID");
    }
    callIds.add(call.id);
    return { id: call.id, target: call.target, input: cloneJson(call.input) };
  });
  return snapshot({
    message: normalizeMessage(output.message),
    calls,
    artifacts: output.artifacts.map(normalizeArtifact),
  });
}

function descriptor(
  identity: string,
  role: Parameters<typeof createPortableSchemaDescriptor>[0]["role"],
  projection: Json,
): PortableSchemaDescriptor {
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
function entry<T>(
  descriptorValue: PortableSchemaDescriptor,
  valueParser: Parser<T>,
): SchemaBinding {
  return {
    descriptor: descriptorValue,
    schema: standardSchemaOf("sweatpants", (value) => {
      const parsed = valueParser.parse(value);
      return parsed.ok
        ? { value: parsed.value as unknown as Json }
        : { issues: parsed.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
    }),
  };
}
function requireParsed<T>(valueParser: Parser<T>, value: unknown, fallback: string): T {
  const parsed = valueParser.parse(value);
  if (!parsed.ok) {
    invalid(parsed.issues[0]?.message ?? fallback);
  }
  return parsed.value;
}
function semanticResult<T>(operation: () => T) {
  try {
    return success(operation());
  } catch (error) {
    if (error instanceof CrankError) {
      return failure<T>({ path: [], message: error.message, code: error.code });
    }
    throw error;
  }
}
function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return sortedResourceValues(new Set(values), (a, b) => a.localeCompare(b));
}
function snapshot<T>(value: T): T {
  return deepFreeze(cloneJson(value as unknown as Json) as unknown as T);
}
function invalid(message: string): never {
  throw new CrankError("invalid_chat_program", message);
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
