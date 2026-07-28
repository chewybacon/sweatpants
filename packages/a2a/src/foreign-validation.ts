import { CrankError } from "@sweatpants/durable-execution";
import { assertJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";

import type {
  ForeignA2AArtifact,
  ForeignA2AMessage,
  ForeignA2ANormalizedState,
  ForeignA2APart,
  ForeignA2ASendResult,
  ForeignA2ATask,
} from "./foreign-task-types.ts";

export interface ForeignA2AValidationLimits {
  readonly maxCanonicalBytes: number;
  readonly maxParts: number;
  readonly maxArtifacts: number;
  readonly maxHistoryMessages: number;
  readonly maxTextBytes: number;
}
const DEFAULT_LIMITS: ForeignA2AValidationLimits = {
  maxCanonicalBytes: 2 * 1024 * 1024,
  maxParts: 256,
  maxArtifacts: 256,
  maxHistoryMessages: 1_000,
  maxTextBytes: 1024 * 1024,
};
const STATES: Readonly<Record<string, ForeignA2ANormalizedState>> = Object.freeze({
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_INPUT_REQUIRED: "input_required",
  TASK_STATE_AUTH_REQUIRED: "auth_required",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  TASK_STATE_REJECTED: "rejected",
});

export function parseForeignA2ASendResult(
  value: unknown,
  limits: Partial<ForeignA2AValidationLimits> = {},
): ForeignA2ASendResult {
  const bounded = boundedJson(value, limits);
  if (!record(bounded)) {
    throw protocol("SendMessage response must be an object");
  }
  if (exactKeys(bounded, ["task"])) {
    return { type: "task", task: parseForeignA2ATask(bounded["task"], limits) };
  }
  if (exactKeys(bounded, ["message"])) {
    return { type: "message", message: parseForeignA2AMessage(bounded["message"], limits) };
  }
  // Some HTTP+JSON implementations return the Task or Message object directly.
  if ("status" in bounded && "id" in bounded) {
    return { type: "task", task: parseForeignA2ATask(bounded, limits) };
  }
  if ("messageId" in bounded && "role" in bounded) {
    return { type: "message", message: parseForeignA2AMessage(bounded, limits) };
  }
  throw protocol("SendMessage response must contain exactly one task or message");
}

export function parseForeignA2ATask(
  value: unknown,
  inputLimits: Partial<ForeignA2AValidationLimits> = {},
): ForeignA2ATask {
  const limits = normalizedLimits(inputLimits);
  const bounded = boundedJson(value, limits);
  if (
    !record(bounded) ||
    !onlyKeys(bounded, ["id", "status"], ["contextId", "artifacts", "history", "metadata"]) ||
    !id(bounded["id"]) ||
    !record(bounded["status"])
  ) {
    throw protocol("Invalid closed A2A Task");
  }
  const status = bounded["status"];
  if (!onlyKeys(status, ["state"], ["message", "timestamp"])) {
    throw protocol("Invalid closed A2A TaskStatus");
  }
  const state = STATES[String(status["state"] ?? "")];
  if (!state) {
    throw protocol("Unknown or unspecified A2A task state");
  }
  if (bounded["contextId"] !== undefined && !id(bounded["contextId"])) {
    throw protocol("Invalid A2A context identity");
  }
  const artifacts = bounded["artifacts"] ?? [];
  if (!Array.isArray(artifacts) || artifacts.length > limits.maxArtifacts) {
    throw protocol("A2A artifact collection exceeds its bound");
  }
  const history = bounded["history"];
  if (
    history !== undefined &&
    (!Array.isArray(history) || history.length > limits.maxHistoryMessages)
  ) {
    throw protocol("A2A task history exceeds its bound");
  }
  const parsed: ForeignA2ATask = {
    id: bounded["id"],
    ...(typeof bounded["contextId"] === "string" ? { contextId: bounded["contextId"] } : {}),
    status: {
      state,
      ...(status["message"] !== undefined
        ? { message: parseForeignA2AMessage(status["message"], limits) }
        : {}),
      ...(typeof status["timestamp"] === "string"
        ? { timestamp: validInstant(status["timestamp"], "task status timestamp") }
        : {}),
    },
    artifacts: artifacts.map((artifact) => parseArtifact(artifact, limits)),
    ...(Array.isArray(history)
      ? { history: history.map((message) => parseForeignA2AMessage(message, limits)) }
      : {}),
    ...(bounded["metadata"] !== undefined ? { metadata: bounded["metadata"] } : {}),
  };
  return Object.freeze(parsed);
}

export function parseForeignA2AMessage(
  value: unknown,
  inputLimits: Partial<ForeignA2AValidationLimits> = {},
): ForeignA2AMessage {
  const limits = normalizedLimits(inputLimits);
  const bounded = boundedJson(value, limits);
  if (
    !record(bounded) ||
    !onlyKeys(
      bounded,
      ["messageId", "role", "parts"],
      ["taskId", "contextId", "metadata", "extensions", "referenceTaskIds"],
    ) ||
    !id(bounded["messageId"]) ||
    !Array.isArray(bounded["parts"]) ||
    bounded["parts"].length === 0 ||
    bounded["parts"].length > limits.maxParts
  ) {
    throw protocol("Invalid closed A2A Message");
  }
  const role =
    bounded["role"] === "ROLE_USER" || bounded["role"] === "user"
      ? "user"
      : bounded["role"] === "ROLE_AGENT" || bounded["role"] === "agent"
        ? "agent"
        : undefined;
  if (!role) {
    throw protocol("Invalid A2A message role");
  }
  if (bounded["taskId"] !== undefined && !id(bounded["taskId"])) {
    throw protocol("Invalid A2A task identity");
  }
  if (bounded["contextId"] !== undefined && !id(bounded["contextId"])) {
    throw protocol("Invalid A2A context identity");
  }
  const extensions = bounded["extensions"];
  if (extensions !== undefined && (!Array.isArray(extensions) || !extensions.every(nonempty))) {
    throw protocol("Invalid A2A message extensions");
  }
  const references = bounded["referenceTaskIds"];
  if (
    references !== undefined &&
    (!Array.isArray(references) || references.length > 256 || !references.every(id))
  ) {
    throw protocol("Invalid A2A task references");
  }
  return Object.freeze({
    messageId: bounded["messageId"],
    role,
    parts: bounded["parts"].map((part) => parsePart(part, limits)),
    ...(typeof bounded["taskId"] === "string" ? { taskId: bounded["taskId"] } : {}),
    ...(typeof bounded["contextId"] === "string" ? { contextId: bounded["contextId"] } : {}),
    ...(bounded["metadata"] !== undefined ? { metadata: bounded["metadata"] } : {}),
    ...(Array.isArray(extensions) ? { extensions: [...extensions] as string[] } : {}),
    ...(Array.isArray(references) ? { referenceTaskIds: [...references] as string[] } : {}),
  });
}

export function foreignA2ATaskDigest(task: ForeignA2ATask): string {
  return canonicalSnapshot(task).sha;
}
export function foreignA2AMessageDigest(message: ForeignA2AMessage): string {
  return canonicalSnapshot(message).sha;
}

export type ForeignA2AArtifactChunk = {
  readonly updateId: string;
  readonly taskId: string;
  readonly artifact: ForeignA2AArtifact;
  readonly append: boolean;
  readonly lastChunk: boolean;
};

/** Bounded stream assembler; reconnect recovery replaces it from GetTask snapshots. */
export class ForeignA2AArtifactStreamAssembler {
  readonly #artifacts = new Map<string, ForeignA2AArtifact>();
  readonly #updates = new Map<string, string>();
  constructor(readonly maxPartsPerArtifact = 1_024) {
    if (!Number.isSafeInteger(maxPartsPerArtifact) || maxPartsPerArtifact <= 0) {
      throw new CrankError("invalid_descriptor", "Artifact part limit must be positive");
    }
  }
  apply(chunk: ForeignA2AArtifactChunk): ForeignA2AArtifact {
    const key = `${chunk.taskId}\u0000${chunk.updateId}`;
    const digest = canonicalSnapshot(chunk).sha;
    const previousDigest = this.#updates.get(key);
    if (previousDigest && previousDigest !== digest) {
      throw new CrankError(
        "a2a_observation_conflict",
        "Artifact update identity was reused with conflicting content",
      );
    }
    const artifactKey = `${chunk.taskId}\u0000${chunk.artifact.artifactId}`;
    const previous = this.#artifacts.get(artifactKey);
    if (previousDigest && previous) {
      return previous;
    }
    const next =
      chunk.append && previous
        ? { ...chunk.artifact, parts: [...previous.parts, ...chunk.artifact.parts] }
        : { ...chunk.artifact, parts: [...chunk.artifact.parts] };
    if (next.parts.length > this.maxPartsPerArtifact) {
      throw new CrankError("payload_too_large", "Assembled A2A artifact exceeds its part bound");
    }
    this.#updates.set(key, digest);
    this.#artifacts.set(artifactKey, next);
    return next;
  }
  reconcile(task: ForeignA2ATask): void {
    for (const key of [...this.#artifacts.keys()]) {
      if (key.startsWith(`${task.id}\u0000`)) {
        this.#artifacts.delete(key);
      }
    }
    for (const artifact of task.artifacts) {
      this.#artifacts.set(`${task.id}\u0000${artifact.artifactId}`, {
        ...artifact,
        parts: [...artifact.parts],
      });
    }
  }
  artifact(taskId: string, artifactId: string): ForeignA2AArtifact | undefined {
    return this.#artifacts.get(`${taskId}\u0000${artifactId}`);
  }
}

export function assertConsistentForeignObservation(
  observations: Readonly<Record<string, string>>,
  identity: string,
  digest: string,
): Readonly<Record<string, string>> {
  const previous = observations[identity];
  if (previous && previous !== digest) {
    throw new CrankError(
      "a2a_observation_conflict",
      "Remote identity was reused with conflicting content",
    );
  }
  return previous ? observations : Object.freeze({ ...observations, [identity]: digest });
}

function parseArtifact(value: unknown, limits: ForeignA2AValidationLimits): ForeignA2AArtifact {
  const bounded = boundedJson(value, limits);
  if (
    !record(bounded) ||
    !onlyKeys(
      bounded,
      ["artifactId", "parts"],
      ["name", "description", "metadata", "extensions"],
    ) ||
    !id(bounded["artifactId"]) ||
    !Array.isArray(bounded["parts"]) ||
    bounded["parts"].length === 0 ||
    bounded["parts"].length > limits.maxParts
  ) {
    throw protocol("Invalid closed A2A Artifact");
  }
  return Object.freeze({
    artifactId: bounded["artifactId"],
    ...(typeof bounded["name"] === "string" ? { name: bounded["name"] } : {}),
    ...(typeof bounded["description"] === "string" ? { description: bounded["description"] } : {}),
    parts: bounded["parts"].map((part) => parsePart(part, limits)),
    ...(bounded["metadata"] !== undefined ? { metadata: bounded["metadata"] } : {}),
  });
}
function parsePart(value: unknown, limits: ForeignA2AValidationLimits): ForeignA2APart {
  const bounded = boundedJson(value, limits);
  if (
    !record(bounded) ||
    !onlyKeys(bounded, [], ["text", "raw", "url", "data", "metadata", "filename", "mediaType"])
  ) {
    throw protocol("Invalid closed A2A Part");
  }
  const content = ["text", "raw", "url", "data"].filter((key) => key in bounded);
  if (content.length !== 1) {
    throw protocol("A2A Part must contain exactly one content field");
  }
  if (bounded["text"] !== undefined) {
    if (
      typeof bounded["text"] !== "string" ||
      new TextEncoder().encode(bounded["text"]).byteLength > limits.maxTextBytes
    ) {
      throw protocol("A2A text part exceeds its bound");
    }
  }
  if (
    bounded["raw"] !== undefined &&
    (typeof bounded["raw"] !== "string" || !base64(bounded["raw"]))
  ) {
    throw protocol("Invalid A2A raw part");
  }
  if (bounded["url"] !== undefined && typeof bounded["url"] !== "string") {
    throw protocol("Invalid A2A URL part");
  }
  return Object.freeze({
    ...(typeof bounded["text"] === "string" ? { text: bounded["text"] } : {}),
    ...(typeof bounded["raw"] === "string" ? { raw: bounded["raw"] } : {}),
    ...(typeof bounded["url"] === "string" ? { url: bounded["url"] } : {}),
    ...(bounded["data"] !== undefined ? { data: bounded["data"] } : {}),
    ...(typeof bounded["filename"] === "string" ? { filename: bounded["filename"] } : {}),
    ...(typeof bounded["mediaType"] === "string" ? { mediaType: bounded["mediaType"] } : {}),
    ...(bounded["metadata"] !== undefined ? { metadata: bounded["metadata"] } : {}),
  });
}
function boundedJson(value: unknown, input: Partial<ForeignA2AValidationLimits>): Json {
  const limits = normalizedLimits(input);
  let snapshot;
  try {
    snapshot = canonicalSnapshot(assertJson(value));
  } catch (error) {
    throw new CrankError("a2a_protocol_error", "A2A value is not canonical JSON", undefined, {
      cause: error,
    });
  }
  if (new TextEncoder().encode(snapshot.canonical).byteLength > limits.maxCanonicalBytes) {
    throw new CrankError("payload_too_large", "A2A value exceeds its canonical bound");
  }
  return snapshot.value;
}
function normalizedLimits(input: Partial<ForeignA2AValidationLimits>): ForeignA2AValidationLimits {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const value of Object.values(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CrankError("invalid_descriptor", "A2A validation limits must be positive integers");
    }
  }
  return result;
}
function validInstant(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw protocol(`Invalid ${field}`);
  }
  return new Date(value).toISOString();
}
function base64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
function record(value: unknown): value is Record<string, Json> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f]/.test(value)
  );
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function exactKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function onlyKeys(
  value: Record<string, Json>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}
function protocol(message: string): CrankError {
  return new CrankError("a2a_protocol_error", message);
}
