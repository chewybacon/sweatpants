import type { ToolExecutionTrace, EmissionTraceEntry } from "../browser-rendering/emissions.ts";
import type { ConversationReplayToolTrace } from "./replay-types.ts";

export const PLUGIN_REPLAY_ACTIVITY_TYPE = "sweatpants:plugin-replay" as const;

export const PLUGIN_REPLAY_LIMITS = {
  maxIncomingTraceEmissions: 32,
  maxMergedTraceEmissionsPerToolCall: 128,
  maxTraceJsonDepth: 20,
  maxIncomingTraceBytes: 64 * 1024,
  maxMergedActivityContentBytes: 256 * 1024,
} as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface NormalizeReplayTraceOptions {
  interruptId?: string;
  limits?: Partial<typeof PLUGIN_REPLAY_LIMITS>;
}

export interface PluginReplayTraceSource {
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  interruptId?: string;
  trace: ToolExecutionTrace;
}

export interface PluginReplayActivityContent {
  version: 1;
  toolCallId: string;
  toolName: string;
  trace: ToolExecutionTrace & { version: 1 };
}

export interface PluginReplayActivitySnapshotEvent {
  type: "ACTIVITY_SNAPSHOT";
  messageId: `sweatpants:plugin-replay:${string}`;
  activityType: typeof PLUGIN_REPLAY_ACTIVITY_TYPE;
  replace: true;
  content: PluginReplayActivityContent;
}

const invalidJson = Symbol("invalid-json");
type InvalidJson = typeof invalidJson;

function limitsWithDefaults(limits: NormalizeReplayTraceOptions["limits"] = {}) {
  return { ...PLUGIN_REPLAY_LIMITS, ...limits };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function encodedSize(value: unknown): number | null {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return null;
  }
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  maxDepth: number,
  seen: WeakSet<object>,
  options: { omitUndefinedProperties: boolean },
): JsonValue | InvalidJson {
  if (depth > maxDepth) {
    return invalidJson;
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : invalidJson;
  }

  if (typeof value === "undefined") {
    return invalidJson;
  }

  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    return invalidJson;
  }

  if (typeof value !== "object") {
    return invalidJson;
  }

  if (seen.has(value)) {
    return invalidJson;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const cloned: JsonValue[] = [];
    for (const item of value) {
      const next = cloneJsonValue(item, depth + 1, maxDepth, seen, options);
      if (next === invalidJson) {
        return invalidJson;
      }
      cloned.push(next);
    }
    return cloned;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalidJson;
  }

  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length > 0) {
    return invalidJson;
  }

  const cloned: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined && options.omitUndefinedProperties) {
      continue;
    }
    const next = cloneJsonValue(item, depth + 1, maxDepth, seen, options);
    if (next === invalidJson) {
      return invalidJson;
    }
    cloned[key] = next;
  }
  return cloned;
}

function cloneJsonObject(value: unknown, maxDepth: number): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const cloned = cloneJsonValue(value, 0, maxDepth, new WeakSet<object>(), {
    omitUndefinedProperties: true,
  });
  return cloned !== invalidJson && isRecord(cloned) && !Array.isArray(cloned)
    ? (cloned as Record<string, unknown>)
    : null;
}

function cloneOptionalJsonValue(value: unknown, maxDepth: number): unknown | InvalidJson {
  return cloneJsonValue(value, 0, maxDepth, new WeakSet<object>(), {
    omitUndefinedProperties: true,
  });
}

function entryMergeKey(entry: EmissionTraceEntry): string {
  return entry.sourceInterruptId
    ? `${entry.sourceInterruptId}\u0000${entry.emissionId}`
    : `emission\u0000${entry.emissionId}`;
}

function reindexTrace(trace: ToolExecutionTrace): ToolExecutionTrace & { version: 1 } {
  return {
    version: 1,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
    emissions: trace.emissions.map((entry, index) => ({
      ...entry,
      order: index,
    })),
  };
}

/**
 * Normalize untrusted browser replay metadata into JSON-only trace content.
 * Array order is canonical: this function derives `order` from array position and
 * never sorts by `timestamp`, which is only display/debug metadata.
 */
export function normalizeClientReplayTrace(
  input: unknown,
  options: NormalizeReplayTraceOptions = {},
): (ToolExecutionTrace & { version: 1 }) | null {
  const limits = limitsWithDefaults(options.limits);
  if (!isRecord(input)) {
    return null;
  }

  if (input["version"] !== 1) {
    return null;
  }
  if (!finiteNumber(input["startedAt"]) || !finiteNumber(input["completedAt"])) {
    return null;
  }

  const rawEmissions = input["emissions"];
  if (!Array.isArray(rawEmissions)) {
    return null;
  }
  if (rawEmissions.length > limits.maxIncomingTraceEmissions) {
    return null;
  }

  const emissions: EmissionTraceEntry[] = [];
  for (let index = 0; index < rawEmissions.length; index++) {
    const rawEntry = rawEmissions[index];
    if (!isRecord(rawEntry)) {
      return null;
    }

    const componentKey = rawEntry["componentKey"];
    const timestamp = rawEntry["timestamp"];
    if (typeof componentKey !== "string" || componentKey.length === 0) {
      return null;
    }
    if (!finiteNumber(timestamp)) {
      return null;
    }

    const props = cloneJsonObject(rawEntry["props"], limits.maxTraceJsonDepth);
    if (!props) {
      return null;
    }

    const responseValue = rawEntry["response"];
    const hasResponse = Object.prototype.hasOwnProperty.call(rawEntry, "response");
    const response = hasResponse
      ? cloneOptionalJsonValue(responseValue, limits.maxTraceJsonDepth)
      : undefined;
    if (response === invalidJson) {
      return null;
    }

    const emissionId = rawEntry["emissionId"];
    if (typeof emissionId !== "string" || emissionId.length === 0) {
      return null;
    }
    const sourceInterruptId = rawEntry["sourceInterruptId"] ?? options.interruptId;

    emissions.push({
      order: index,
      emissionId,
      ...(typeof sourceInterruptId === "string" && sourceInterruptId.length > 0
        ? { sourceInterruptId }
        : {}),
      componentKey,
      props,
      ...(hasResponse ? { response } : {}),
      timestamp,
    });
  }

  const trace: ToolExecutionTrace & { version: 1 } = {
    version: 1,
    startedAt: input["startedAt"],
    completedAt: input["completedAt"],
    emissions,
  };

  const size = encodedSize(trace);
  if (size === null || size > limits.maxIncomingTraceBytes) {
    return null;
  }

  return trace;
}

/**
 * Merge replay traces by stable per-emission identity. Existing positions are
 * preserved for duplicate keys; new keys append in durable arrival order.
 */
export function mergePluginReplayTrace(
  existing: ToolExecutionTrace | undefined,
  incoming: PluginReplayTraceSource,
): ToolExecutionTrace & { version: 1 } {
  const limits = limitsWithDefaults();
  const merged = existing ? [...existing.emissions] : [];
  const indexByKey = new Map<string, number>();

  for (let index = 0; index < merged.length; index++) {
    const key = entryMergeKey(merged[index]!);
    indexByKey.set(key, index);
  }

  for (const entry of incoming.trace.emissions) {
    const normalizedEntry: EmissionTraceEntry = {
      ...entry,
      ...(incoming.interruptId && !entry.sourceInterruptId
        ? { sourceInterruptId: incoming.interruptId }
        : {}),
    };
    const key = entryMergeKey(normalizedEntry);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      merged[existingIndex] = normalizedEntry;
    } else if (merged.length < limits.maxMergedTraceEmissionsPerToolCall) {
      indexByKey.set(key, merged.length);
      merged.push(normalizedEntry);
    }
  }

  const startedAtCandidates = [existing?.startedAt, incoming.trace.startedAt].filter(finiteNumber);
  const completedAtCandidates = [existing?.completedAt, incoming.trace.completedAt].filter(
    finiteNumber,
  );

  return reindexTrace({
    version: 1,
    startedAt: startedAtCandidates.length > 0 ? Math.min(...startedAtCandidates) : Date.now(),
    completedAt: completedAtCandidates.length > 0 ? Math.max(...completedAtCandidates) : Date.now(),
    emissions: merged,
  });
}

export function buildPluginReplayActivity(source: {
  toolCallId: string;
  toolName: string;
  trace: ToolExecutionTrace;
}): PluginReplayActivitySnapshotEvent | null {
  const normalized = normalizeClientReplayTrace(source.trace);
  if (!normalized) {
    return null;
  }
  const trace = reindexTrace(normalized);
  const content: PluginReplayActivityContent = {
    version: 1,
    toolCallId: source.toolCallId,
    toolName: source.toolName,
    trace,
  };
  const size = encodedSize(content);
  if (size === null || size > PLUGIN_REPLAY_LIMITS.maxMergedActivityContentBytes) {
    return null;
  }

  return {
    type: "ACTIVITY_SNAPSHOT",
    messageId: `sweatpants:plugin-replay:${source.toolCallId}`,
    activityType: PLUGIN_REPLAY_ACTIVITY_TYPE,
    replace: true,
    content,
  };
}

export function activityContentToPluginReplayTrace(
  content: unknown,
): ConversationReplayToolTrace | null {
  if (!isRecord(content)) {
    return null;
  }
  if (content["version"] !== 1) {
    return null;
  }
  const toolCallId = content["toolCallId"];
  const toolName = content["toolName"];
  const trace = content["trace"];
  if (typeof toolCallId !== "string" || typeof toolName !== "string") {
    return null;
  }
  const normalized = normalizeClientReplayTrace(trace);
  if (!normalized) {
    return null;
  }
  return { callId: toolCallId, toolName, trace: normalized };
}

export function activityMessageToPluginReplayTrace(
  message: unknown,
): ConversationReplayToolTrace | null {
  if (!isRecord(message)) {
    return null;
  }
  if (message["role"] !== "activity") {
    return null;
  }
  if (message["activityType"] !== PLUGIN_REPLAY_ACTIVITY_TYPE) {
    return null;
  }
  return activityContentToPluginReplayTrace(message["content"]);
}

export function activitySnapshotToPluginReplayTrace(
  event: unknown,
): ConversationReplayToolTrace | null {
  if (!isRecord(event)) {
    return null;
  }
  if (event["type"] !== "ACTIVITY_SNAPSHOT") {
    return null;
  }
  if (event["activityType"] !== PLUGIN_REPLAY_ACTIVITY_TYPE) {
    return null;
  }
  return activityContentToPluginReplayTrace(event["content"]);
}
