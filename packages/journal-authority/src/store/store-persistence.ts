import {
  decodeJsonValue,
  durableKey,
  encodeJsonValue,
  type StoredAuthorityRecord,
} from "@sweatpants/durable-storage-kernel";
import {
  canonicalJson,
  canonicalSnapshot,
  parseJsonText,
  sha256,
  sha256Bytes,
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
  const object = record(decodeJsonValue(value, "execution control"), "execution control");
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

function validatePrivateEntryBounds(segment: StoredPrivateSegment): void {
  const first = BigInt(counter(segment.firstSequence, "privateSegment.firstSequence"));
  const last = BigInt(counter(segment.lastSequence, "privateSegment.lastSequence"));
  if (last < first || last - first + 1n !== BigInt(segment.entries.length)) {
    return invalid(`Private segment ${segment.segmentId} has an invalid sequence range`);
  }
  if (
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

export function encodePrivateSegment(value: StoredPrivateSegment): Uint8Array {
  validatePrivateEntryBounds(value);
  const encoded = canonicalSnapshot(value.entries);
  if (encoded.sha !== value.contentHash) {
    return invalid(`Private segment ${value.segmentId} content hash is invalid`);
  }
  if (privateEnvelopeEncoder.encode(encoded.canonical).byteLength !== value.encodedBytes) {
    return invalid(`Private segment ${value.segmentId} encoded byte count is invalid`);
  }
  return encodePrivateSegmentEnvelopeFromCanonical(value, encoded.canonical);
}

export function decodePrivateSegment(value: Uint8Array): StoredPrivateSegment {
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
  if (sha256(entriesJson) !== result.contentHash) {
    return invalid(`Private segment ${result.segmentId} content hash is invalid`);
  }
  if (privateEnvelopeEncoder.encode(entriesJson).byteLength !== result.encodedBytes) {
    return invalid(`Private segment ${result.segmentId} encoded byte count is invalid`);
  }
  validatePrivateEntryBounds(result);
  return result;
}

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(value >> 18) & 63];
    result += alphabet[(value >> 12) & 63];
    result += second === undefined ? "=" : alphabet[(value >> 6) & 63];
    result += third === undefined ? "=" : alphabet[value & 63];
  }
  return result;
}

function decodeBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return invalid("execution object binary body is not canonical base64");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset < value.length; offset += 4) {
    const chars = value.slice(offset, offset + 4);
    const a = alphabet.indexOf(chars[0]!);
    const b = alphabet.indexOf(chars[1]!);
    const c = chars[2] === "=" ? 0 : alphabet.indexOf(chars[2]!);
    const d = chars[3] === "=" ? 0 : alphabet.indexOf(chars[3]!);
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((bits >> 16) & 255);
    if (chars[2] !== "=") {
      bytes.push((bits >> 8) & 255);
    }
    if (chars[3] !== "=") {
      bytes.push(bits & 255);
    }
  }
  return new Uint8Array(bytes);
}

export function encodeExecutionObjectEnvelope(value: StoredExecutionObject): Uint8Array {
  return jsonEncode({
    objectId: value.objectId,
    lifetimeScope: value.lifetimeScope,
    scopeOwnerId: value.scopeOwnerId,
    objectKind: value.objectKind,
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    bodyKind: value.body instanceof Uint8Array ? "binary" : "json",
    body: value.body instanceof Uint8Array ? encodeBase64(value.body) : value.body,
    createdAt: value.createdAt,
  });
}

export function encodeExecutionObject(value: StoredExecutionObject): Uint8Array {
  const content =
    value.body instanceof Uint8Array
      ? { hash: sha256Bytes(value.body), bytes: value.body.byteLength }
      : (() => {
          const snapshot = canonicalSnapshot(value.body);
          return {
            hash: snapshot.sha,
            bytes: new TextEncoder().encode(snapshot.canonical).byteLength,
          };
        })();
  if (content.hash !== value.contentHash || content.bytes !== value.byteLength) {
    return invalid(`Execution object ${value.objectId} content metadata is invalid`);
  }
  return encodeExecutionObjectEnvelope(value);
}

export function decodeExecutionObject(value: Uint8Array): StoredExecutionObject {
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
  const content =
    result.body instanceof Uint8Array
      ? { hash: sha256Bytes(result.body), bytes: result.body.byteLength }
      : (() => {
          const snapshot = canonicalSnapshot(result.body);
          return {
            hash: snapshot.sha,
            bytes: new TextEncoder().encode(snapshot.canonical).byteLength,
          };
        })();
  if (content.hash !== result.contentHash || content.bytes !== result.byteLength) {
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
