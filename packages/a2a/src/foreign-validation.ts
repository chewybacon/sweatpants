import { CrankError } from "@sweatpants/durable-execution";
import {
  assertJson,
  canonicalSnapshot,
  hasControlCharacter,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import { z } from "zod";

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

const identitySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !hasControlCharacter(value));
const partSchema = z
  .strictObject({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    data: z.json().optional(),
    metadata: z.json().optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .refine(
    (value) =>
      ["text", "raw", "url", "data"].filter(
        (key) => key in value && value[key as "text"] !== undefined,
      ).length === 1,
  );
const artifactSchema = z.strictObject({
  artifactId: identitySchema,
  parts: z.array(partSchema).min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.json().optional(),
  extensions: z.json().optional(),
});
const messageSchema = z.strictObject({
  messageId: identitySchema,
  role: z.enum(["ROLE_USER", "user", "ROLE_AGENT", "agent"]),
  parts: z.array(partSchema).min(1),
  taskId: identitySchema.optional(),
  contextId: identitySchema.optional(),
  metadata: z.json().optional(),
  extensions: z.array(z.string().min(1)).optional(),
  referenceTaskIds: z.array(identitySchema).max(256).optional(),
});
const taskSchema = z.strictObject({
  id: identitySchema,
  status: z.strictObject({
    state: z.string(),
    message: z.json().optional(),
    timestamp: z.string().optional(),
  }),
  contextId: identitySchema.optional(),
  artifacts: z.array(z.json()).optional(),
  history: z.array(z.json()).optional(),
  metadata: z.json().optional(),
});

export function parseForeignA2ASendResult(
  value: unknown,
  limits: Partial<ForeignA2AValidationLimits> = {},
): ForeignA2ASendResult {
  const bounded = boundedJson(value, limits);
  const envelope = z
    .union([
      z.strictObject({ task: z.json() }),
      z.strictObject({ message: z.json() }),
      z.record(z.string(), z.json()),
    ])
    .safeParse(bounded);
  if (!envelope.success) {
    throw protocol("SendMessage response must be an object");
  }
  const result = envelope.data;
  if ("task" in result && Object.keys(result).length === 1) {
    return { type: "task", task: parseForeignA2ATask(result["task"], limits) };
  }
  if ("message" in result && Object.keys(result).length === 1) {
    return { type: "message", message: parseForeignA2AMessage(result["message"], limits) };
  }
  // Some HTTP+JSON implementations return the Task or Message object directly.
  if ("status" in result && "id" in result) {
    return { type: "task", task: parseForeignA2ATask(result, limits) };
  }
  if ("messageId" in result && "role" in result) {
    return { type: "message", message: parseForeignA2AMessage(result, limits) };
  }
  throw protocol("SendMessage response must contain exactly one task or message");
}

export function parseForeignA2ATask(
  value: unknown,
  inputLimits: Partial<ForeignA2AValidationLimits> = {},
): ForeignA2ATask {
  const limits = normalizedLimits(inputLimits);
  const bounded = boundedJson(value, limits);
  const parsed = taskSchema.safeParse(bounded);
  if (!parsed.success) {
    throw protocol("Invalid closed A2A Task");
  }
  const task = parsed.data;
  const state = STATES[task.status.state];
  if (!state) {
    throw protocol("Unknown or unspecified A2A task state");
  }
  const artifacts = task.artifacts ?? [];
  if (artifacts.length > limits.maxArtifacts) {
    throw protocol("A2A artifact collection exceeds its bound");
  }
  const history = task.history;
  if (history !== undefined && history.length > limits.maxHistoryMessages) {
    throw protocol("A2A task history exceeds its bound");
  }
  const parsedTask: ForeignA2ATask = {
    id: task.id,
    ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
    status: {
      state,
      ...(task.status.message !== undefined
        ? { message: parseForeignA2AMessage(task.status.message, limits) }
        : {}),
      ...(task.status.timestamp !== undefined
        ? { timestamp: validInstant(task.status.timestamp, "task status timestamp") }
        : {}),
    },
    artifacts: artifacts.map((artifact) => parseArtifact(artifact, limits)),
    ...(history !== undefined
      ? { history: history.map((message) => parseForeignA2AMessage(message, limits)) }
      : {}),
    ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
  };
  return Object.freeze(parsedTask);
}

export function parseForeignA2AMessage(
  value: unknown,
  inputLimits: Partial<ForeignA2AValidationLimits> = {},
): ForeignA2AMessage {
  const limits = normalizedLimits(inputLimits);
  const bounded = boundedJson(value, limits);
  const parsed = messageSchema.safeParse(bounded);
  if (!parsed.success || parsed.data.parts.length > limits.maxParts) {
    throw protocol("Invalid closed A2A Message");
  }
  const message = parsed.data;
  const role = message.role === "ROLE_USER" || message.role === "user" ? "user" : "agent";
  return Object.freeze({
    messageId: message.messageId,
    role,
    parts: message.parts.map((part) => parsePart(part, limits)),
    ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
    ...(message.contextId !== undefined ? { contextId: message.contextId } : {}),
    ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
    ...(message.extensions !== undefined ? { extensions: [...message.extensions] } : {}),
    ...(message.referenceTaskIds !== undefined
      ? { referenceTaskIds: [...message.referenceTaskIds] }
      : {}),
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
type StoredArtifact = { readonly taskId: string; readonly artifact: ForeignA2AArtifact };

export class ForeignA2AArtifactStreamAssembler {
  readonly #artifacts = new Map<string, StoredArtifact>();
  readonly #updates = new Map<string, string>();
  constructor(readonly maxPartsPerArtifact = 1_024) {
    if (!Number.isSafeInteger(maxPartsPerArtifact) || maxPartsPerArtifact <= 0) {
      throw new CrankError("invalid_descriptor", "Artifact part limit must be positive");
    }
  }
  apply(chunk: ForeignA2AArtifactChunk): ForeignA2AArtifact {
    const key = stableTupleHash([chunk.taskId, chunk.updateId]);
    const digest = canonicalSnapshot(chunk).sha;
    const previousDigest = this.#updates.get(key);
    if (previousDigest && previousDigest !== digest) {
      throw new CrankError(
        "a2a_observation_conflict",
        "Artifact update identity was reused with conflicting content",
      );
    }
    const artifactKey = stableTupleHash([chunk.taskId, chunk.artifact.artifactId]);
    const previousRecord = this.#artifacts.get(artifactKey);
    const previous = previousRecord?.artifact;
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
    this.#artifacts.set(artifactKey, { taskId: chunk.taskId, artifact: next });
    return next;
  }
  reconcile(task: ForeignA2ATask): void {
    for (const [key, record] of this.#artifacts) {
      if (record.taskId === task.id) {
        this.#artifacts.delete(key);
      }
    }
    for (const artifact of task.artifacts) {
      this.#artifacts.set(stableTupleHash([task.id, artifact.artifactId]), {
        taskId: task.id,
        artifact: { ...artifact, parts: [...artifact.parts] },
      });
    }
  }
  artifact(taskId: string, artifactId: string): ForeignA2AArtifact | undefined {
    return this.#artifacts.get(stableTupleHash([taskId, artifactId]))?.artifact;
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
  const parsed = artifactSchema.safeParse(bounded);
  if (!parsed.success || parsed.data.parts.length > limits.maxParts) {
    throw protocol("Invalid closed A2A Artifact");
  }
  const artifact = parsed.data;
  return Object.freeze({
    artifactId: artifact.artifactId,
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.description !== undefined ? { description: artifact.description } : {}),
    parts: artifact.parts.map((part) => parsePart(part, limits)),
    ...(artifact.metadata !== undefined ? { metadata: artifact.metadata } : {}),
  });
}
function parsePart(value: unknown, limits: ForeignA2AValidationLimits): ForeignA2APart {
  const bounded = boundedJson(value, limits);
  const parsed = partSchema.safeParse(bounded);
  if (!parsed.success) {
    throw protocol("Invalid closed A2A Part");
  }
  const part = parsed.data;
  if (
    part.text !== undefined &&
    new TextEncoder().encode(part.text).byteLength > limits.maxTextBytes
  ) {
    throw protocol("A2A text part exceeds its bound");
  }
  if (part.raw !== undefined && !base64(part.raw)) {
    throw protocol("Invalid A2A raw part");
  }
  return Object.freeze({
    ...(part.text !== undefined ? { text: part.text } : {}),
    ...(part.raw !== undefined ? { raw: part.raw } : {}),
    ...(part.url !== undefined ? { url: part.url } : {}),
    ...(part.data !== undefined ? { data: part.data } : {}),
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
    ...(part.mediaType !== undefined ? { mediaType: part.mediaType } : {}),
    ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
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
function protocol(message: string): CrankError {
  return new CrankError("a2a_protocol_error", message);
}
