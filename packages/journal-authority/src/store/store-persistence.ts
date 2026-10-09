import { bytesToHex } from "@noble/hashes/utils.js";
import {
  durableKey,
  DURABLE_SCAN_MAX_BYTES,
  type StoredAuthorityRecord,
} from "@sweatpants/durable-storage-kernel";
import {
  canonicalJson,
  encodeCanonicalJson,
  assertJson,
  sha256,
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

function record(value: unknown, label: string): Readonly<Record<string, Json>> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return invalid(`${label} must be an object`);
  }
  return value as Readonly<Record<string, Json>>;
}

function text(value: Json | undefined, field: string): string {
  if (typeof value !== "string") {
    return invalid(`${field} must be a string`);
  }
  return assertJson(value) as string;
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

/** Validates owned decoded JSON; the returned control retains its nested value. */
export function readExecutionControl(value: unknown): ExecutionControl {
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
  const control = readExecutionControl(value.value);
  if (control.controlRevision !== value.revision || control.ownerFence !== value.fence) {
    return invalid(
      `Execution control ${control.executionId} disagrees with its authority envelope`,
    );
  }
  return control;
}

function validatePrivateEntryBounds(segment: StoredPrivateSegment, canonicalBytes: number): void {
  const first = BigInt(counter(segment.firstSequence, "privateSegment.firstSequence"));
  const last = BigInt(counter(segment.lastSequence, "privateSegment.lastSequence"));
  if (last < first || last - first + 1n !== BigInt(segment.entries.length)) {
    return invalid(`Private segment ${segment.segmentId} has an invalid sequence range`);
  }
  if (canonicalBytes > DURABLE_SCAN_MAX_BYTES) {
    throw new ExecutionStoreError(
      "segment_entry_too_large",
      `Private segment ${segment.segmentId} exceeds the maximum readable segment payload`,
    );
  }
  if (
    canonicalBytes > 1024 * 1024 &&
    segment.entries.some(
      (entry) => privateEnvelopeEncoder.encode(encodeCanonicalJson(entry)).byteLength > 1024 * 1024,
    )
  ) {
    throw new ExecutionStoreError(
      "segment_entry_too_large",
      `Private segment ${segment.segmentId} contains an oversized inline entry`,
    );
  }
}

const privateEnvelopeEncoder = new TextEncoder();
/** Construct an owned segment and retain its structured persistence value. */
export async function createPrivateSegment(
  fields: Omit<StoredPrivateSegment, "segmentId" | "contentHash" | "encodedBytes" | "entries">,
  entries: readonly Json[],
): Promise<StoredPrivateSegment> {
  const metadata = structuredClone(fields);
  const owned = assertJson(entries) as Json[];
  const canonical = encodeCanonicalJson(owned);
  const bytes = privateEnvelopeEncoder.encode(canonical);
  const contentHash = await digestBytes(bytes);
  const pending: object[] = [owned];
  while (pending.length) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") {
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  if (metadata.previous) {
    Object.freeze(metadata.previous);
  }
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
  return value;
}

export function preparePrivateSegment(value: StoredPrivateSegment): StoredPrivateSegment {
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
  return value;
}

export async function readPrivateSegment(value: unknown): Promise<StoredPrivateSegment> {
  const object = record(value, "private segment");
  const entries = object["entries"];
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
  const bytes = privateEnvelopeEncoder.encode(canonicalJson(entries));
  if ((await digestBytes(bytes)) !== result.contentHash) {
    return invalid(`Private segment ${result.segmentId} content hash is invalid`);
  }
  if (bytes.byteLength !== result.encodedBytes) {
    return invalid(`Private segment ${result.segmentId} encoded byte count is invalid`);
  }
  validatePrivateEntryBounds(result, bytes.byteLength);
  return result;
}

async function digestBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return bytesToHex(digest);
}

/** Own immutable text and its content identity. */
export async function createTextExecutionObject(
  fields: Omit<StoredExecutionObject, "contentHash" | "byteLength" | "body">,
  body: string,
): Promise<StoredExecutionObject> {
  const metadata = { ...fields };
  const canonical = canonicalJson(body);
  const bytes = privateEnvelopeEncoder.encode(canonical);
  const contentHash = await digestBytes(bytes);
  const value = Object.freeze({ ...metadata, body, contentHash, byteLength: bytes.byteLength });
  return value;
}

/** Prepares content-addressed JSON once, retaining its structured value for the eventual write. */
export async function createContentAddressedExecutionObject(
  fields: Omit<StoredExecutionObject, "objectId" | "contentHash" | "byteLength" | "body">,
  identityPrefix: readonly string[],
  body: unknown,
): Promise<StoredExecutionObject> {
  const metadata = { ...fields };
  const prefix = [...identityPrefix];
  const owned = assertJson(body);
  const canonical = encodeCanonicalJson(owned);
  const bytes = privateEnvelopeEncoder.encode(canonical);
  const pending: object[] = owned !== null && typeof owned === "object" ? [owned] : [];
  while (pending.length) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") {
        pending.push(child);
      }
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
  return value;
}

export function prepareExecutionObject(value: StoredExecutionObject): StoredExecutionObject {
  natural(value.createdAt, "object.createdAt");
  const bodyJson = canonicalJson(value.body);
  const hash = sha256(bodyJson);
  const bytes = privateEnvelopeEncoder.encode(bodyJson).byteLength;
  if (hash !== value.contentHash || bytes !== value.byteLength) {
    return invalid(`Execution object ${value.objectId} content metadata is invalid`);
  }
  return value;
}

export async function readExecutionObject(value: unknown): Promise<StoredExecutionObject> {
  const object = record(value, "execution object");
  const lifetimeScope = text(object["lifetimeScope"], "object.lifetimeScope");
  if (lifetimeScope !== "execution" && lifetimeScope !== "conversation") {
    return invalid(`Unknown execution object scope ${lifetimeScope}`);
  }
  const encodedBody = object["body"];
  if (encodedBody === undefined) {
    return invalid("object.body is missing");
  }
  const body = encodedBody;
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
  const bytes = privateEnvelopeEncoder.encode(encodeCanonicalJson(result.body));
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
