import { CrankError } from "@sweatpants/durable-execution";
import { canonicalSnapshot, type Json, type JsonObject } from "@sweatpants/foundation";
import {
  createPortableSchemaDescriptor,
  standardSchemaOf,
  type SchemaBinding,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { sortedResourceValues, type DataClassification } from "@sweatpants/agent-sdk";

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
  entry(inputDescriptor, (value) => parseAuthoredChatTurnInput(value)),
  entry(resultDescriptor, (value) => parseAuthoredChatTurnResult(value)),
  entry(authoredModelSampleInputDescriptor, (value) => parseAuthoredChatModelSampleRequest(value)),
  entry(authoredModelSampleOutputDescriptor, (value) => parseAuthoredChatModelSampleResult(value)),
]);

export function parseAuthoredChatTurnInput(value: unknown): AuthoredChatTurnInput {
  const input = exactRecord(value, ["message", "context"], "chat turn input");
  return snapshot({
    message: parseAuthoredChatMessage(input["message"]),
    context: parseAuthoredChatContext(input["context"]),
  });
}

export function parseAuthoredChatTurnResult(value: unknown): AuthoredChatTurnResult {
  const result = exactRecord(value, ["message", "artifacts"], "chat turn result");
  if (!Array.isArray(result["artifacts"])) {
    invalid("invalid chat result");
  }
  const ids = new Set<string>();
  const artifacts = result["artifacts"].map((artifact) => {
    const parsed = parseAuthoredChatArtifact(artifact);
    if (ids.has(parsed.id)) {
      invalid("duplicate artifact ID");
    }
    ids.add(parsed.id);
    return parsed;
  });
  return snapshot({
    message: parseAuthoredChatMessage(result["message"]),
    artifacts,
  });
}

export function parseAuthoredChatMessage(value: unknown): AuthoredChatMessage {
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
    role: role as AuthoredChatMessage["role"],
    parts: message["parts"].map(parseAuthoredPart),
  });
}

export function parseAuthoredContentPart(value: unknown): AuthoredChatContentPart {
  return parseAuthoredPart(value);
}

function parseAuthoredChatContext(value: unknown): AuthoredChatContextView {
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
        summary: parseAuthoredChatMessage(task["summary"]),
      };
    }),
    messages: context["messages"].map(parseAuthoredChatMessage),
    truncation: {
      omittedMessages: nonnegative(truncation["omittedMessages"], "omitted messages"),
      omittedReferencedTasks: nonnegative(truncation["omittedReferencedTasks"], "omitted tasks"),
    },
  });
}

function parseAuthoredChatArtifact(value: unknown): AuthoredChatArtifact {
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
    parts: artifact["parts"].map(parseAuthoredPart),
  });
}

function parseAuthoredPart(value: unknown): AuthoredChatContentPart {
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

export function parseAuthoredChatModelSampleRequest(
  value: unknown,
): AuthoredChatModelSampleRequest {
  const input = exactRecord(
    value,
    ["messages", "systemPrompt", "tools", "classifications", "sampling"],
    "model sample input",
  );
  if (
    !Array.isArray(input["messages"]) ||
    !Array.isArray(input["tools"]) ||
    !Array.isArray(input["classifications"])
  ) {
    invalid("invalid model sample input");
  }
  return snapshot({
    messages: input["messages"].map(parseAuthoredChatMessage),
    systemPrompt: parseAuthoredContentPart(input["systemPrompt"]),
    tools: input["tools"].map((tool) => canonicalSnapshot(tool as Json).value),
    classifications: input["classifications"].map(classification),
    sampling: canonicalSnapshot(input["sampling"] as Json).value,
  });
}

export function parseAuthoredChatModelSampleResult(value: unknown): AuthoredChatModelSampleResult {
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
    message: parseAuthoredChatMessage(output["message"]),
    calls,
    artifacts: output["artifacts"].map(parseAuthoredChatArtifact),
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
  parse: (value: unknown) => Json,
): SchemaBinding {
  return {
    descriptor: descriptorValue,
    schema: standardSchemaOf("sweatpants", (value) => {
      try {
        return { value: parse(value) };
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
