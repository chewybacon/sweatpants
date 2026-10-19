import { assertJson, stableTupleHash, type Json } from "@sweatpants/foundation";
import {
  parsePortableSchemaDescriptor,
  type PortableSchemaDescriptor,
} from "@sweatpants/foundation/schema";
import { z } from "zod";

export interface ResumeEntry {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

/** Interrupt response schemas are JSON Schema documents: always keyed objects. */
const responseSchemaSchema = z.record(z.string(), z.unknown());

export type InterruptStatus = "open" | "resolved" | "cancelled" | "expired";

export interface OpenInterruptRecord {
  threadId: string;
  scopeId: string;
  interruptedRunId: string;
  interruptId: string;
  reason: string;
  message?: string;
  toolCallId?: string;
  toolName?: string;
  sessionId?: string;
  runtimeId?: string;
  executionId?: string;
  continuationRef?: unknown;
  responseSchema?: Record<string, unknown>;
  bindingId?: string;
  context?: Json;
  responseContract?: PortableSchemaDescriptor;
  contextContract?: PortableSchemaDescriptor;
  placement?: { nodeId: string; parentNodeId: string | null; sequence: number };
  publicMetadata?: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
  status: InterruptStatus;
  resolvedByRunId?: string;
  resolutionHash?: string;
}

export interface ResumeValidationSuccess {
  ok: true;
  scopeId: string;
  records: OpenInterruptRecord[];
  entries: ResumeEntry[];
  idempotent: boolean;
}

export interface ResumeValidationFailure {
  ok: false;
  message: string;
  code: "INVALID_RESUME" | "RESUME_EXPIRED" | "RESUME_PAYLOAD_INVALID" | "RESUME_CONFLICT";
}

export type ResumeValidationResult = ResumeValidationSuccess | ResumeValidationFailure;

const recordsByKey = new Map<string, OpenInterruptRecord>();

export function scopeIdForInterruptRun(threadId: string, interruptedRunId: string): string {
  return stableTupleHash([threadId, interruptedRunId]);
}

function keyFor(threadId: string, scopeId: string, interruptId: string): string {
  return stableTupleHash([threadId, scopeId, interruptId]);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function resumeResolutionHash(entry: ResumeEntry): string {
  return canonicalJson({ status: entry.status, payload: entry.payload });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function jsonValue(value: unknown): Json | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return assertJson(value);
  } catch {
    return undefined;
  }
}

function portableDescriptor(value: unknown): PortableSchemaDescriptor | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parsePortableSchemaDescriptor(value);
  } catch {
    return undefined;
  }
}

function isPlacement(value: unknown): value is {
  nodeId: string;
  parentNodeId: string | null;
  sequence: number;
} {
  const record = asRecord(value);
  return (
    record !== null &&
    typeof record["nodeId"] === "string" &&
    (record["parentNodeId"] === null || typeof record["parentNodeId"] === "string") &&
    typeof record["sequence"] === "number" &&
    Number.isSafeInteger(record["sequence"]) &&
    record["sequence"] >= 0
  );
}

function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function verifyJsonSchemaSubset(
  schema: Record<string, unknown> | undefined,
  value: unknown,
): boolean {
  if (!schema) {
    return true;
  }
  const record = schema;
  const enumValues = Array.isArray(record["enum"]) ? record["enum"] : undefined;
  if (
    enumValues &&
    !enumValues.some((candidate) => canonicalJson(candidate) === canonicalJson(value))
  ) {
    return false;
  }

  const type = record["type"];
  if (typeof type === "string" && !schemaTypeMatches(type, value)) {
    return false;
  }
  if (
    Array.isArray(type) &&
    type.every((entry) => typeof entry === "string") &&
    !type.some((entry) => schemaTypeMatches(entry, value))
  ) {
    return false;
  }

  if (record["const"] !== undefined && canonicalJson(record["const"]) !== canonicalJson(value)) {
    return false;
  }

  const required = Array.isArray(record["required"])
    ? record["required"].filter((entry): entry is string => typeof entry === "string")
    : [];
  const properties = asRecord(record["properties"]) ?? {};
  const objectValue = asRecord(value);
  if (required.length > 0) {
    if (!objectValue) {
      return false;
    }
    for (const requiredKey of required) {
      if (!(requiredKey in objectValue)) {
        return false;
      }
    }
  }
  if (objectValue) {
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (
        property in objectValue &&
        !verifyJsonSchemaSubset(
          responseSchemaSchema.safeParse(propertySchema).data,
          objectValue[property],
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

export function registerInterruptsFromRunFinished(event: unknown): void {
  const runFinished = asRecord(event);
  if (!runFinished || runFinished["type"] !== "RUN_FINISHED") {
    return;
  }
  const threadId = typeof runFinished["threadId"] === "string" ? runFinished["threadId"] : "";
  const runId = typeof runFinished["runId"] === "string" ? runFinished["runId"] : "";
  const outcome = asRecord(runFinished["outcome"]);
  if (
    !threadId ||
    !runId ||
    outcome?.["type"] !== "interrupt" ||
    !Array.isArray(outcome["interrupts"])
  ) {
    return;
  }

  const scopeId = scopeIdForInterruptRun(threadId, runId);
  for (const interrupt of outcome["interrupts"]) {
    const candidate = asRecord(interrupt);
    if (!candidate || typeof candidate["id"] !== "string") {
      continue;
    }
    // Pull/interrupt IDs are stable within a conversation. Recovery may
    // project the same pending interrupt under a fresh transport runId; keep
    // its original scope so a stale replay cannot rebind resume authority.
    const existingOpen = [...recordsByKey.values()].find(
      (record) =>
        record.threadId === threadId &&
        record.interruptId === candidate["id"] &&
        record.status === "open",
    );
    if (existingOpen) {
      continue;
    }
    const metadata = asRecord(candidate["metadata"]) ?? {};
    const elicitationFacts = asRecord(metadata["sweatpants/elicitation"]) ?? {};
    const toolCallId =
      typeof candidate["toolCallId"] === "string" ? candidate["toolCallId"] : undefined;
    const sessionId =
      typeof metadata["sweatpants/sessionId"] === "string"
        ? metadata["sweatpants/sessionId"]
        : toolCallId;
    const toolName =
      typeof metadata["sweatpants/toolName"] === "string"
        ? metadata["sweatpants/toolName"]
        : undefined;
    const context = jsonValue(candidate["context"] ?? elicitationFacts["context"]);
    const responseContract = portableDescriptor(
      candidate["responseContract"] ?? elicitationFacts["responseContract"],
    );
    const contextContract = portableDescriptor(
      candidate["contextContract"] ?? elicitationFacts["contextContract"],
    );
    const record: OpenInterruptRecord = {
      threadId,
      scopeId,
      interruptedRunId: runId,
      interruptId: candidate["id"],
      reason: typeof candidate["reason"] === "string" ? candidate["reason"] : "input_required",
      /* CONDITIONAL-SPREAD: Omit absent message from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(typeof candidate["message"] === "string" ? { message: candidate["message"] } : {}),
      /* CONDITIONAL-SPREAD: Omit absent toolCallId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(toolCallId ? { toolCallId } : {}),
      /* CONDITIONAL-SPREAD: Omit absent toolName from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(toolName ? { toolName } : {}),
      /* CONDITIONAL-SPREAD: Omit absent sessionId, executionId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(sessionId ? { sessionId, executionId: sessionId } : {}),
      /* CONDITIONAL-SPREAD: Omit absent responseSchema from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(responseSchemaSchema.safeParse(candidate["responseSchema"]).success
        ? { responseSchema: candidate["responseSchema"] as Record<string, unknown> }
        : {}),
      /* CONDITIONAL-SPREAD: Omit absent bindingId from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(typeof candidate["bindingId"] === "string"
        ? { bindingId: candidate["bindingId"] }
        : typeof elicitationFacts["bindingId"] === "string"
          ? { bindingId: elicitationFacts["bindingId"] }
          : {}),
      /* CONDITIONAL-SPREAD: Omit absent context from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(context !== undefined ? { context } : {}),
      /* CONDITIONAL-SPREAD: Omit absent responseContract from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(responseContract ? { responseContract } : {}),
      /* CONDITIONAL-SPREAD: Omit absent contextContract from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(contextContract ? { contextContract } : {}),
      /* CONDITIONAL-SPREAD: Omit absent placement from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(isPlacement(candidate["placement"])
        ? { placement: candidate["placement"] }
        : isPlacement(elicitationFacts["placement"])
          ? { placement: elicitationFacts["placement"] }
          : {}),
      /* CONDITIONAL-SPREAD: Omit absent publicMetadata from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(Object.keys(metadata).length > 0 ? { publicMetadata: metadata } : {}),
      /* CONDITIONAL-SPREAD: Omit absent expiresAt from chat admission, journal, and projection records; explicit undefined is not a portable JSON value. */
      ...(typeof candidate["expiresAt"] === "string" ? { expiresAt: candidate["expiresAt"] } : {}),
      createdAt: new Date().toISOString(),
      status: "open",
    };
    recordsByKey.set(keyFor(threadId, scopeId, record.interruptId), record);
  }
}

function isTerminalStatus(status: InterruptStatus): boolean {
  return status === "resolved" || status === "cancelled" || status === "expired";
}

export function upsertInterruptRecords(records: OpenInterruptRecord[]): void {
  for (const record of records) {
    const key = keyFor(record.threadId, record.scopeId, record.interruptId);
    const existing = recordsByKey.get(key);
    if (existing && isTerminalStatus(existing.status) && !isTerminalStatus(record.status)) {
      continue;
    }
    recordsByKey.set(key, record);
  }
}

export function interruptRecordsForThread(threadId: string): OpenInterruptRecord[] {
  return [...recordsByKey.values()].filter((record) => record.threadId === threadId);
}

export function resetInterruptRegistry(): void {
  recordsByKey.clear();
}

export function openInterruptsForThread(threadId: string): OpenInterruptRecord[] {
  return interruptRecordsForThread(threadId).filter((record) => record.status === "open");
}

/** Mirrors an authority-accepted typed response into the process-local render index. */
export function settleInterruptForThread(
  threadId: string,
  interruptId: string,
  status: "resolved" | "cancelled",
): void {
  upsertInterruptRecords(
    openInterruptsForThread(threadId)
      .filter((record) => record.interruptId === interruptId)
      .map((record) => ({ ...record, status })),
  );
}

/** Marks every open interrupt on a thread cancelled after stop or supersession. */
export function cancelOpenInterruptsForThread(threadId: string): void {
  upsertInterruptRecords(
    openInterruptsForThread(threadId).map((record) => ({
      ...record,
      status: "cancelled" as const,
    })),
  );
}

export function deriveResumeScopeId(
  threadId: string,
  parentRunId: string | undefined,
): string | null {
  if (parentRunId) {
    return scopeIdForInterruptRun(threadId, parentRunId);
  }
  const open = openInterruptsForThread(threadId);
  const scopes = new Set(open.map((record) => record.scopeId));
  return scopes.size === 1 ? [...scopes][0]! : null;
}

export function deriveResumeScopeFromEntries(
  resume: ResumeEntry[] | undefined,
): { threadId: string; scopeId: string } | null {
  if (!resume?.length) {
    return null;
  }
  const matched = resume.flatMap((entry) =>
    [...recordsByKey.values()].filter((record) => record.interruptId === entry.interruptId),
  );
  const threadIds = new Set(matched.map((record) => record.threadId));
  const scopeIds = new Set(matched.map((record) => record.scopeId));
  if (threadIds.size !== 1 || scopeIds.size !== 1) {
    return null;
  }
  return { threadId: [...threadIds][0]!, scopeId: [...scopeIds][0]! };
}

export function verifyResumeEntries(params: {
  threadId: string;
  scopeId: string;
  runId: string;
  resume?: ResumeEntry[];
  now?: Date;
}): ResumeValidationResult {
  const { threadId, scopeId, runId, resume = [], now = new Date() } = params;
  const scopeRecords = [...recordsByKey.values()].filter(
    (record) => record.threadId === threadId && record.scopeId === scopeId,
  );
  const openRecords = scopeRecords.filter((record) => record.status === "open");

  if (openRecords.length === 0) {
    if (resume.length === 0) {
      return { ok: true, scopeId, records: [], entries: [], idempotent: false };
    }
    const seen = new Set<string>();
    for (const entry of resume) {
      if (seen.has(entry.interruptId)) {
        return {
          ok: false,
          code: "INVALID_RESUME",
          message: `Duplicate resume interruptId: ${entry.interruptId}`,
        };
      }
      seen.add(entry.interruptId);
      const record = scopeRecords.find((candidate) => candidate.interruptId === entry.interruptId);
      if (!record) {
        return {
          ok: false,
          code: "INVALID_RESUME",
          message: `Unknown or stale resume interruptId: ${entry.interruptId}`,
        };
      }
      if (record.resolutionHash !== resumeResolutionHash(entry)) {
        return {
          ok: false,
          code: "RESUME_CONFLICT",
          message: `Resume conflicts with settled interrupt: ${entry.interruptId}`,
        };
      }
    }
    return { ok: true, scopeId, records: [], entries: resume, idempotent: true };
  }

  if (resume.length === 0) {
    return { ok: false, code: "INVALID_RESUME", message: "Open interrupts require resume[]" };
  }

  const seen = new Set<string>();
  for (const entry of resume) {
    if (seen.has(entry.interruptId)) {
      return {
        ok: false,
        code: "INVALID_RESUME",
        message: `Duplicate resume interruptId: ${entry.interruptId}`,
      };
    }
    seen.add(entry.interruptId);
  }

  const openIds = new Set(openRecords.map((record) => record.interruptId));
  for (const record of openRecords) {
    if (!seen.has(record.interruptId)) {
      return {
        ok: false,
        code: "INVALID_RESUME",
        message: `Missing resume for interruptId: ${record.interruptId}`,
      };
    }
  }
  for (const entry of resume) {
    if (!openIds.has(entry.interruptId)) {
      const stale = scopeRecords.find((record) => record.interruptId === entry.interruptId);
      if (stale?.resolutionHash === resumeResolutionHash(entry)) {
        continue;
      }
      return {
        ok: false,
        code: stale ? "RESUME_CONFLICT" : "INVALID_RESUME",
        message: `Unknown or stale resume interruptId: ${entry.interruptId}`,
      };
    }
  }

  for (const record of openRecords) {
    if (record.expiresAt && Date.parse(record.expiresAt) < now.getTime()) {
      return {
        ok: false,
        code: "RESUME_EXPIRED",
        message: `Interrupt expired: ${record.interruptId}`,
      };
    }
    const entry = resume.find((candidate) => candidate.interruptId === record.interruptId)!;
    if (entry.status === "resolved" && record.responseSchema !== undefined) {
      const payloadRecord = asRecord(entry.payload);
      const action = payloadRecord?.["action"];
      // Decline/cancel carries no business content and is valid independently
      // of the accept-content schema.
      if (action === "decline" || action === "cancel") {
        continue;
      }
      const businessPayload =
        action === "accept" && "content" in payloadRecord!
          ? payloadRecord!["content"]
          : entry.payload;
      if (!verifyJsonSchemaSubset(record.responseSchema, businessPayload)) {
        return {
          ok: false,
          code: "RESUME_PAYLOAD_INVALID",
          message: `Resume payload invalid for interruptId: ${record.interruptId}`,
        };
      }
    }
  }

  const resolvedRecords = openRecords.map((record) => {
    const entry = resume.find((candidate) => candidate.interruptId === record.interruptId)!;
    return {
      ...record,
      status: entry.status === "cancelled" ? ("cancelled" as const) : ("resolved" as const),
      resolvedByRunId: runId,
      resolutionHash: resumeResolutionHash(entry),
    };
  });

  return { ok: true, scopeId, records: resolvedRecords, entries: resume, idempotent: false };
}
