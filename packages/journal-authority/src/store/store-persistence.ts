import { bytesToHex } from "@noble/hashes/utils.js";
import { fromByteArray, toByteArray } from "base64-js";
import {
  decodeJsonValue,
  durableKey,
  encodeJsonValue,
  type StoredAuthorityRecord,
} from "@sweatpants/durable-storage-kernel";
import {
  canonicalJson,
  assertJson,
  parseJsonText,
  sha256,
  sha256Bytes,
  stableTupleHash,
  type Json,
} from "@sweatpants/foundation";
import {
  ExecutionStoreError,
  type ExecutionControl,
  type StoredExecutionObject,
  type StoredPrivateSegment,
} from "./store.ts";

function invalid(message: string): never {
  throw new ExecutionStoreError("persisted_data_invalid", message);
}

function record(value: Json, label: string): Readonly<Record<string, Json>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return invalid(`${label} must be an object`);
  }
  return value;
}

function text(value: Json | undefined, field: string): string {
  return typeof value === "string" ? value : invalid(`${field} must be a string`);
}

function natural(value: Json | undefined, field: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : invalid(`${field} must be a non-negative safe integer`);
}

function counter(value: Json | undefined, field: string): string {
  const result = text(value, field);
  return /^(0|[1-9]\d*)$/.test(result)
    ? result
    : invalid(`${field} must be a canonical durable counter`);
}

function nullablePointer(
  value: Json | undefined,
  label: string,
): { readonly segmentId: string; readonly lastSequence: string } | null {
  if (value === null) {
    return null;
  }
  const object = record(value ?? null, label);
  return {
    segmentId: text(object["segmentId"], `${label}.segmentId`),
    lastSequence: counter(object["lastSequence"], `${label}.lastSequence`),
  };
}

function jsonEncode<T>(value: T): Uint8Array {
  return encodeJsonValue(value as unknown as Json);
}

export function encodeExecutionControl(value: ExecutionControl): Uint8Array {
  return jsonEncode(value);
}

export function decodeExecutionControl(value: Uint8Array): ExecutionControl {
  return decodeExecutionControlJson(decodeJsonValue(value, "execution control"));
}

/** Validates owned decoded JSON; the returned control retains its nested value. */
export function decodeExecutionControlJson(value: Json): ExecutionControl {
  const object = record(value, "execution control");
  const status = text(object["status"], "control.status");
  if (!(["active", "parked", "cancelling", "terminal"] as const).includes(status as never)) {
    return invalid(`Unknown execution status ${status}`);
  }
  const disposition = object["requestedDisposition"];
  if (disposition !== null && disposition !== "cancelled" && disposition !== "superseded") {
    return invalid(`Unknown requested disposition ${String(disposition)}`);
  }
  const control = object["control"];
  if (control === undefined) {
    return invalid("control.control is missing");
  }
  return {
    executionId: text(object["executionId"], "control.executionId"),
    controlRevision: counter(object["controlRevision"], "control.controlRevision"),
    ownerFence: counter(object["ownerFence"], "control.ownerFence"),
    status: status as ExecutionControl["status"],
    rootTaskId: text(object["rootTaskId"], "control.rootTaskId"),
    stopGeneration: counter(object["stopGeneration"], "control.stopGeneration"),
    requestedDisposition: disposition as ExecutionControl["requestedDisposition"],
    control,
    updatedAt: natural(object["updatedAt"], "control.updatedAt"),
  };
}

export function decodeAuthorityControl(value: StoredAuthorityRecord): ExecutionControl {
  const control = decodeExecutionControl(value.value);
  if (control.controlRevision !== value.revision || control.ownerFence !== value.fence) {
    return invalid(
      `Execution control ${control.executionId} disagrees with its authority envelope`,
    );
  }
  return control;
}

function validatePrivateEntryBounds(segment: StoredPrivateSegment, canonicalBytes?: number): void {
  const first = BigInt(counter(segment.firstSequence, "privateSegment.firstSequence"));
  const last = BigInt(counter(segment.lastSequence, "privateSegment.lastSequence"));
  if (last < first || last - first + 1n !== BigInt(segment.entries.length)) {
    return invalid(`Private segment ${segment.segmentId} has an invalid sequence range`);
  }
  if (
    (canonicalBytes === undefined || canonicalBytes > 1024 * 1024) &&
    segment.entries.some(
      (entry) => new TextEncoder().encode(canonicalJson(entry)).byteLength > 1024 * 1024,
    )
  ) {
    throw new ExecutionStoreError(
      "segment_entry_too_large",
      `Private segment ${segment.segmentId} contains an oversized inline entry`,
    );
  }
}

const privateEnvelopeEncoder = new TextEncoder();
const privateEnvelopeDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodePrivateSegmentEnvelopeFromCanonical(
  value: Omit<StoredPrivateSegment, "entries">,
  canonicalEntries: string,
): Uint8Array {
  const metadata = canonicalJson({
    segmentId: value.segmentId,
    executionId: value.executionId,
    taskId: value.taskId,
    previous: value.previous,
    firstSequence: value.firstSequence,
    lastSequence: value.lastSequence,
    contentHash: value.contentHash,
    encodedBytes: value.encodedBytes,
    createdAt: value.createdAt,
  });
  return privateEnvelopeEncoder.encode(`${metadata}\n${canonicalEntries}`);
}

export function encodePrivateSegmentEnvelope(value: StoredPrivateSegment): Uint8Array {
  return encodePrivateSegmentEnvelopeFromCanonical(value, canonicalJson(value.entries));
}

const preparedPrivateSegments = new WeakMap<StoredPrivateSegment, Uint8Array>();

/** Construct an owned segment and reuse its exact validated envelope at commit. */
export async function createPrivateSegment(
  fields: Omit<StoredPrivateSegment, "segmentId" | "contentHash" | "encodedBytes" | "entries">,
  entries: readonly Json[],
): Promise<StoredPrivateSegment> {
  const metadata = structuredClone(fields);
  const canonical = canonicalJson(entries);
  const bytes = privateEnvelopeEncoder.encode(canonical);
  const contentHash = await digestBytes(bytes);
  const owned = JSON.parse(canonical) as Json[];
  const pending: object[] = [owned];
  while (pending.length) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  if (metadata.previous) Object.freeze(metadata.previous);
  const value = Object.freeze({
    ...metadata,
    segmentId: stableTupleHash([
      metadata.executionId,
      metadata.taskId,
      metadata.firstSequence,
      contentHash,
    ]),
    entries: owned,
    contentHash,
    encodedBytes: bytes.byteLength,
  });
  validatePrivateEntryBounds(value, bytes.byteLength);
  preparedPrivateSegments.set(value, encodePrivateSegmentEnvelopeFromCanonical(value, canonical));
  return value;
}

export function encodePrivateSegment(value: StoredPrivateSegment): Uint8Array {
  const prepared = preparedPrivateSegments.get(value);
  if (prepared) return new Uint8Array(prepared);
  const canonical = canonicalJson(value.entries);
  const byteLength = privateEnvelopeEncoder.encode(canonical).byteLength;
  // Each entry is smaller than its enclosing canonical array. Only oversized
  // batches need individual size checks; ordinary batches already prove it.
  validatePrivateEntryBounds(value, byteLength);
  if (sha256(canonical) !== value.contentHash) {
    return invalid(`Private segment ${value.segmentId} content hash is invalid`);
  }
  if (byteLength !== value.encodedBytes) {
    return invalid(`Private segment ${value.segmentId} encoded byte count is invalid`);
  }
  return encodePrivateSegmentEnvelopeFromCanonical(value, canonical);
}

export async function decodePrivateSegment(value: Uint8Array): Promise<StoredPrivateSegment> {
  let envelope: string;
  try {
    envelope = privateEnvelopeDecoder.decode(value);
  } catch (error) {
    return invalid(
      `Private segment envelope is not UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const separator = envelope.indexOf("\n");
  if (separator <= 0) {
    return invalid("Private segment envelope is missing its body separator");
  }
  const object = record(
    parseJsonText(envelope.slice(0, separator), "private segment metadata"),
    "private segment metadata",
  );
  const entriesJson = envelope.slice(separator + 1);
  const entries = parseJsonText(entriesJson, "private segment entries");
  if (!Array.isArray(entries)) {
    return invalid("privateSegment.entries must be an array");
  }
  const result: StoredPrivateSegment = {
    segmentId: text(object["segmentId"], "privateSegment.segmentId"),
    executionId: text(object["executionId"], "privateSegment.executionId"),
    taskId: text(object["taskId"], "privateSegment.taskId"),
    previous: nullablePointer(object["previous"], "privateSegment.previous"),
    firstSequence: counter(object["firstSequence"], "privateSegment.firstSequence"),
    lastSequence: counter(object["lastSequence"], "privateSegment.lastSequence"),
    entries,
    contentHash: text(object["contentHash"], "privateSegment.contentHash"),
    encodedBytes: natural(object["encodedBytes"], "privateSegment.encodedBytes"),
    createdAt: natural(object["createdAt"], "privateSegment.createdAt"),
  };
  if ((await digestBytes(privateEnvelopeEncoder.encode(entriesJson))) !== result.contentHash) {
    return invalid(`Private segment ${result.segmentId} content hash is invalid`);
  }
  if (privateEnvelopeEncoder.encode(entriesJson).byteLength !== result.encodedBytes) {
    return invalid(`Private segment ${result.segmentId} encoded byte count is invalid`);
  }
  validatePrivateEntryBounds(result);
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalid("execution object binary body is not canonical base64");
  }
  return toByteArray(value);
}

// Content integrity belongs to the body. The envelope is ordinary storage JSON.
function executionObjectEnvelope(value: StoredExecutionObject): Uint8Array {
  const { body, ...metadata } = value;
  return privateEnvelopeEncoder.encode(
    JSON.stringify({
      ...(assertJson(metadata) as Record<string, Json>),
      body: body instanceof Uint8Array ? fromByteArray(body) : body,
      bodyKind: value.body instanceof Uint8Array ? "binary" : "json",
    }),
  );
}

async function digestBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(digest);
}

const preparedObjects = new WeakMap<StoredExecutionObject, Uint8Array>();

/** Own immutable text and its exact persistence envelope in one encoding pass. */
export async function createTextExecutionObject(
  fields: Omit<StoredExecutionObject, "contentHash" | "byteLength" | "body">,
  body: string,
): Promise<StoredExecutionObject> {
  const metadata = { ...fields };
  const canonical = canonicalJson(body);
  const bytes = privateEnvelopeEncoder.encode(canonical);
  const contentHash = await digestBytes(bytes);
  const value = Object.freeze({ ...metadata, body, contentHash, byteLength: bytes.byteLength });
  preparedObjects.set(value, executionObjectEnvelope(value));
  return value;
}

/** Prepares content-addressed JSON once, retaining owned bytes for the eventual write. */
export async function createContentAddressedExecutionObject(
  fields: Omit<StoredExecutionObject, "objectId" | "contentHash" | "byteLength" | "body">,
  identityPrefix: readonly string[],
  body: unknown,
): Promise<StoredExecutionObject> {
  const metadata = { ...fields };
  const prefix = [...identityPrefix];
  const canonical = canonicalJson(body);
  const bytes = privateEnvelopeEncoder.encode(canonical);
  const owned = JSON.parse(canonical) as Json;
  const pending: object[] = owned !== null && typeof owned === "object" ? [owned] : [];
  while (pending.length) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pending.push(child);
    }
    Object.freeze(current);
  }
  const contentHash = await digestBytes(bytes);
  const value = Object.freeze({
    ...metadata,
    objectId: stableTupleHash([...prefix, contentHash]),
    body: owned,
    contentHash,
    byteLength: bytes.byteLength,
  });
  preparedObjects.set(value, executionObjectEnvelope(value));
  return value;
}

export function encodeExecutionObjectEnvelope(value: StoredExecutionObject): Uint8Array {
  return executionObjectEnvelope(value);
}

export function encodeExecutionObject(value: StoredExecutionObject): Uint8Array {
  const prepared = preparedObjects.get(value);
  if (prepared) return new Uint8Array(prepared);
  const body = value.body;
  const bodyJson = canonicalJson(body instanceof Uint8Array ? fromByteArray(body) : body);
  const hash = body instanceof Uint8Array ? sha256Bytes(body) : sha256(bodyJson);
  const bytes =
    body instanceof Uint8Array ? body.byteLength : new TextEncoder().encode(bodyJson).byteLength;
  if (hash !== value.contentHash || bytes !== value.byteLength) {
    return invalid(`Execution object ${value.objectId} content metadata is invalid`);
  }
  return executionObjectEnvelope(value);
}

export async function decodeExecutionObject(value: Uint8Array): Promise<StoredExecutionObject> {
  const object = record(decodeJsonValue(value, "execution object"), "execution object");
  const lifetimeScope = text(object["lifetimeScope"], "object.lifetimeScope");
  if (lifetimeScope !== "execution" && lifetimeScope !== "conversation") {
    return invalid(`Unknown execution object scope ${lifetimeScope}`);
  }
  const bodyKind = text(object["bodyKind"], "object.bodyKind");
  const encodedBody = object["body"];
  if (encodedBody === undefined) {
    return invalid("object.body is missing");
  }
  const body =
    bodyKind === "binary"
      ? decodeBase64(text(encodedBody, "object.body"))
      : bodyKind === "json"
        ? encodedBody
        : invalid(`Unknown execution object body kind ${bodyKind}`);
  const result: StoredExecutionObject = {
    objectId: text(object["objectId"], "object.objectId"),
    lifetimeScope,
    scopeOwnerId: text(object["scopeOwnerId"], "object.scopeOwnerId"),
    objectKind: text(object["objectKind"], "object.objectKind"),
    contentHash: text(object["contentHash"], "object.contentHash"),
    byteLength: natural(object["byteLength"], "object.byteLength"),
    body,
    createdAt: natural(object["createdAt"], "object.createdAt"),
  };
  const bytes =
    result.body instanceof Uint8Array
      ? new Uint8Array(result.body)
      : privateEnvelopeEncoder.encode(canonicalJson(result.body));
  if (bytes.byteLength !== result.byteLength || (await digestBytes(bytes)) !== result.contentHash) {
    return invalid(`Execution object ${result.objectId} content metadata is invalid`);
  }
  return result;
}

export const executionKeys = Object.freeze({
  control: (executionId: string) => durableKey(executionId),
  segment: (segmentId: string) => durableKey(segmentId),
  taskRange: (executionId: string, taskId: string, firstSequence: string, lastSequence: string) =>
    durableKey(executionId, taskId, firstSequence, lastSequence),
  object: (objectId: string) => durableKey(objectId),
});
