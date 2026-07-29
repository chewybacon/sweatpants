import { CrankError } from "@sweatpants/durable-execution";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type SchemaBinding,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { sortedResourceValues, type DataClassification } from "@sweatpants/agent-sdk";

export const CHAT_TURN_INPUT_FORMAT = "sweatpants.chat-turn-input.v1" as const;
export const CHAT_TURN_RESULT_FORMAT = "sweatpants.chat-turn-result.v1" as const;
export const CHAT_CONTEXT_POLICY_FORMAT = "sweatpants.chat-context-policy.v1" as const;

export interface ChatContentPartV1 {
  value: Json;
  provenance: {
    classifications: DataClassification[];
    sourceDigests: string[];
  };
}
export interface ChatMessageV1 {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: ChatContentPartV1[];
}
export interface ReferencedTaskSummaryV1 {
  taskId: string;
  summary: ChatMessageV1;
}
export interface ChatContextViewV1 {
  policyDigest: string;
  frontier: string;
  referenceTaskIds: string[];
  referencedTasks: ReferencedTaskSummaryV1[];
  messages: ChatMessageV1[];
  truncation: { omittedMessages: number; omittedReferencedTasks: number };
}
export interface ChatTurnInputV1 {
  format: typeof CHAT_TURN_INPUT_FORMAT;
  message: ChatMessageV1;
  context: ChatContextViewV1;
}
export interface ChatArtifactV1 {
  id: string;
  name?: string;
  description?: string;
  parts: ChatContentPartV1[];
}
export interface ChatTurnResultV1 {
  format: typeof CHAT_TURN_RESULT_FORMAT;
  message: ChatMessageV1;
  artifacts: ChatArtifactV1[];
}
export interface ChatContextPolicyV1 {
  format: typeof CHAT_CONTEXT_POLICY_FORMAT;
  id: string;
  version: string;
  maxMessages: number;
  maxReferencedTasks: number;
  maxCanonicalBytes: number;
  digest: string;
}
export interface ChatModelToolCallV1 {
  id: string;
  target: string;
  input: Json;
}
export interface ChatModelSampleInputV2 {
  messages: ChatMessageV1[];
  systemPrompt: ChatContentPartV1;
  tools: Json[];
  classifications: DataClassification[];
  sampling: Json;
}
export interface ChatModelSampleOutputV2 {
  message: ChatMessageV1;
  calls: ChatModelToolCallV1[];
  artifacts: ChatArtifactV1[];
}

const inputDescriptor = descriptor("sweatpants.chat-turn/input", "program_input", {
  type: "object",
  required: ["format", "message", "context"],
  properties: { format: { const: CHAT_TURN_INPUT_FORMAT }, message: true, context: true },
  additionalProperties: false,
});
const resultDescriptor = descriptor("sweatpants.chat-turn/result", "program_output", {
  type: "object",
  required: ["format", "message", "artifacts"],
  properties: {
    format: { const: CHAT_TURN_RESULT_FORMAT },
    message: true,
    artifacts: { type: "array" },
  },
  additionalProperties: false,
});
export const CHAT_TURN_INPUT_DESCRIPTOR = inputDescriptor;
export const CHAT_TURN_RESULT_DESCRIPTOR = resultDescriptor;

export const CHAT_CONTRACT_SCHEMA_ENTRIES: readonly SchemaBinding[] = Object.freeze([
  entry(inputDescriptor, (value) => normalizeChatTurnInput(value) as unknown as Json),
  entry(resultDescriptor, (value) => normalizeChatTurnResult(value) as unknown as Json),
]);

export function normalizeChatTurnInput(value: unknown): ChatTurnInputV1 {
  const input = exactRecord(value, ["format", "message", "context"], "chat turn input");
  if (input["format"] !== CHAT_TURN_INPUT_FORMAT) {
    invalid("unsupported chat input format");
  }
  return snapshot({
    format: CHAT_TURN_INPUT_FORMAT,
    message: normalizeChatMessage(input["message"]),
    context: normalizeContext(input["context"]),
  });
}

export function normalizeChatTurnResult(value: unknown): ChatTurnResultV1 {
  const result = exactRecord(value, ["format", "message", "artifacts"], "chat turn result");
  if (result["format"] !== CHAT_TURN_RESULT_FORMAT || !Array.isArray(result["artifacts"])) {
    invalid("invalid chat result");
  }
  const ids = new Set<string>();
  const artifacts = result["artifacts"].map((artifact) => {
    const parsed = normalizeArtifact(artifact);
    if (ids.has(parsed.id)) {
      invalid("duplicate artifact ID");
    }
    ids.add(parsed.id);
    return parsed;
  });
  return snapshot({
    format: CHAT_TURN_RESULT_FORMAT,
    message: normalizeChatMessage(result["message"]),
    artifacts,
  });
}

export function normalizeChatMessage(value: unknown): ChatMessageV1 {
  const message = exactRecord(value, ["id", "role", "parts"], "chat message");
  const role = message["role"];
  if (
    !["user", "assistant", "system", "tool"].includes(String(role)) ||
    !Array.isArray(message["parts"])
  ) {
    invalid("invalid chat message");
  }
  return snapshot({
    id: opaqueId(message["id"], "message ID"),
    role: role as ChatMessageV1["role"],
    parts: message["parts"].map(normalizePart),
  });
}

export function normalizeContentPart(value: unknown): ChatContentPartV1 {
  return normalizePart(value);
}

function normalizeContext(value: unknown): ChatContextViewV1 {
  const context = exactRecord(
    value,
    ["policyDigest", "frontier", "referenceTaskIds", "referencedTasks", "messages", "truncation"],
    "chat context",
  );
  if (
    !Array.isArray(context["referenceTaskIds"]) ||
    !Array.isArray(context["referencedTasks"]) ||
    !Array.isArray(context["messages"])
  ) {
    invalid("invalid context arrays");
  }
  const references: string[] = [];
  const seen = new Set<string>();
  for (const raw of context["referenceTaskIds"]) {
    const id = opaqueId(raw, "reference task ID");
    if (!seen.has(id)) {
      seen.add(id);
      references.push(id);
    }
  }
  const truncation = exactRecord(
    context["truncation"],
    ["omittedMessages", "omittedReferencedTasks"],
    "truncation",
  );
  return snapshot({
    policyDigest: digest(context["policyDigest"], "policy digest"),
    frontier: opaqueId(context["frontier"], "context frontier"),
    referenceTaskIds: references,
    referencedTasks: context["referencedTasks"].map((item) => {
      const task = exactRecord(item, ["taskId", "summary"], "referenced task");
      return {
        taskId: opaqueId(task["taskId"], "task ID"),
        summary: normalizeChatMessage(task["summary"]),
      };
    }),
    messages: context["messages"].map(normalizeChatMessage),
    truncation: {
      omittedMessages: nonnegative(truncation["omittedMessages"], "omitted messages"),
      omittedReferencedTasks: nonnegative(truncation["omittedReferencedTasks"], "omitted tasks"),
    },
  });
}

function normalizeArtifact(value: unknown): ChatArtifactV1 {
  const artifact = optionalRecord(value, ["id", "parts"], ["name", "description"], "artifact");
  if (!Array.isArray(artifact["parts"])) {
    invalid("artifact parts must be an array");
  }
  return snapshot({
    id: opaqueId(artifact["id"], "artifact ID"),
    ...(artifact["name"] !== undefined
      ? { name: boundedText(artifact["name"], 512, "artifact name") }
      : {}),
    ...(artifact["description"] !== undefined
      ? { description: boundedText(artifact["description"], 4096, "artifact description") }
      : {}),
    parts: artifact["parts"].map(normalizePart),
  });
}

function normalizePart(value: unknown): ChatContentPartV1 {
  const part = exactRecord(value, ["value", "provenance"], "content part");
  const provenance = exactRecord(
    part["provenance"],
    ["classifications", "sourceDigests"],
    "provenance",
  );
  if (
    !Array.isArray(provenance["classifications"]) ||
    !Array.isArray(provenance["sourceDigests"])
  ) {
    invalid("invalid provenance");
  }
  const classifications = uniqueSorted(provenance["classifications"].map(classification));
  const sourceDigests = uniqueSorted(
    provenance["sourceDigests"].map((item) => digest(item, "source digest")),
  );
  if (
    classifications.length !== provenance["classifications"].length ||
    sourceDigests.length !== provenance["sourceDigests"].length
  ) {
    invalid("provenance must already be sorted and duplicate-free");
  }
  for (let index = 0; index < classifications.length; index += 1) {
    if (classifications[index] !== provenance["classifications"][index]) {
      invalid("classifications must be sorted");
    }
  }
  for (let index = 0; index < sourceDigests.length; index += 1) {
    if (sourceDigests[index] !== provenance["sourceDigests"][index]) {
      invalid("source digests must be sorted");
    }
  }
  return snapshot({
    value: canonicalSnapshot(part["value"] as Json).value,
    provenance: { classifications, sourceDigests },
  });
}

export function normalizeModelSampleOutput(value: unknown): ChatModelSampleOutputV2 {
  const output = exactRecord(value, ["message", "calls", "artifacts"], "model sample output");
  if (!Array.isArray(output["calls"]) || !Array.isArray(output["artifacts"])) {
    invalid("invalid model sample output");
  }
  const callIds = new Set<string>();
  const calls = output["calls"].map((item) => {
    const call = exactRecord(item, ["id", "target", "input"], "model tool call");
    const id = opaqueId(call["id"], "tool call ID");
    if (callIds.has(id)) {
      invalid("duplicate model tool call ID");
    }
    callIds.add(id);
    return {
      id,
      target: opaqueId(call["target"], "tool target"),
      input: canonicalSnapshot(call["input"] as Json).value,
    };
  });
  return snapshot({
    message: normalizeChatMessage(output["message"]),
    calls,
    artifacts: output["artifacts"].map(normalizeArtifact),
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
function entry(
  descriptorValue: PortableSchemaDescriptor,
  normalize: (value: unknown) => Json,
): SchemaBinding {
  return {
    descriptor: descriptorValue,
    schema: standardSchemaOf("sweatpants", (value) => {
      try {
        return { value: normalize(value) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : "invalid value" }] };
      }
    }),
  };
}
function exactRecord(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => key in value)
  ) {
    invalid(`invalid ${field}`);
  }
  return value as Record<string, unknown>;
}
function optionalRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`invalid ${field}`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every((key) => key in record) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    invalid(`invalid ${field}`);
  }
  return record;
}
function classification(value: unknown): DataClassification {
  if (!["public", "internal", "confidential", "restricted"].includes(String(value))) {
    invalid("invalid classification");
  }
  return value as DataClassification;
}
function opaqueId(value: unknown, field: string): string {
  return boundedText(value, 512, field);
}
function boundedText(value: unknown, maxBytes: number, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    invalid(`invalid ${field}`);
  }
  return value;
}
function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    invalid(`invalid ${field}`);
  }
  return value;
}
function nonnegative(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalid(`invalid ${field}`);
  }
  return Number(value);
}
function uniqueSorted<T extends string>(values: T[]): T[] {
  return sortedResourceValues(new Set(values), (a, b) => a.localeCompare(b));
}
function snapshot<T>(value: T): T {
  return deepFreeze(canonicalSnapshot(value as unknown as Json).value as unknown as T);
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
