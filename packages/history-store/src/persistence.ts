import {
  decodeJsonValue,
  durableKey,
  encodeJsonValue,
  type StoredAuthorityRecord,
  type StoredImmutableRecord,
} from "@sweatpants/durable-storage-kernel";
import { canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { assertCheckpointBounds } from "./checkpoint-bounds.ts";
import {
  assertCheckpointPayload,
  checkpointHotRoots,
  checkpointHotSealedRootCount,
} from "./checkpoint-payload.ts";
import { rootPayloadBytes } from "./segmentation.ts";
import {
  ConversationStoreError,
  type CommandReceipt,
  type ConversationHead,
  type StoredCheckpoint,
  type StoredPublicArchiveSegment,
  type StoredTerminalSegment,
} from "./contract.ts";

function invalid(message: string): never {
  throw new ConversationStoreError("persisted_data_invalid", message);
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

function nullableText(value: Json | undefined, field: string): string | null {
  return value === null ? null : text(value, field);
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

function nullableJson(value: Json | undefined, field: string): Json | null {
  if (value === undefined) {
    return invalid(`${field} is missing`);
  }
  return value;
}

function pointer(value: Json | undefined, label: string): { checkpointId: string } | null {
  if (value === null) {
    return null;
  }
  const object = record(value ?? null, label);
  return { checkpointId: text(object["checkpointId"], `${label}.checkpointId`) };
}

function historyPointer(
  value: Json | undefined,
  label: string,
): { segmentId: string; lastPosition: string } | null {
  if (value === null) {
    return null;
  }
  const object = record(value ?? null, label);
  return {
    segmentId: text(object["segmentId"], `${label}.segmentId`),
    lastPosition: counter(object["lastPosition"], `${label}.lastPosition`),
  };
}

function jsonEncode<T>(value: T): Uint8Array {
  return encodeJsonValue(value as unknown as Json);
}

export function encodeConversationHead(value: ConversationHead): Uint8Array {
  return jsonEncode(value);
}

export function decodeConversationHead(value: Uint8Array): ConversationHead {
  const object = record(decodeJsonValue(value, "conversation head"), "conversation head");
  const state = text(object["state"], "head.state");
  if (!(["idle", "running", "parked", "recovering", "deleted"] as const).includes(state as never)) {
    return invalid(`Unknown conversation state ${state}`);
  }
  const deletedAt =
    object["deletedAt"] === null ? null : natural(object["deletedAt"], "head.deletedAt");
  if ((state === "deleted") !== (deletedAt !== null)) {
    return invalid("Conversation deleted state and deletedAt disagree");
  }
  return {
    conversationId: text(object["conversationId"], "head.conversationId"),
    revision: counter(object["revision"], "head.revision"),
    ownerEpoch: counter(object["ownerEpoch"], "head.ownerEpoch"),
    ownerRoute: nullableJson(object["ownerRoute"], "head.ownerRoute"),
    state: state as ConversationHead["state"],
    checkpoint: pointer(object["checkpoint"], "head.checkpoint"),
    terminalHistory: historyPointer(object["terminalHistory"], "head.terminalHistory"),
    activeLogicalTurnId: nullableText(object["activeLogicalTurnId"], "head.activeLogicalTurnId"),
    activeExecutionId: nullableText(object["activeExecutionId"], "head.activeExecutionId"),
    latestCompletedExecutionId: nullableText(
      object["latestCompletedExecutionId"],
      "head.latestCompletedExecutionId",
    ),
    activeSegment: nullableJson(object["activeSegment"], "head.activeSegment"),
    activeCommand: nullableJson(object["activeCommand"], "head.activeCommand"),
    deletedAt,
    updatedAt: natural(object["updatedAt"], "head.updatedAt"),
  };
}

export function decodeAuthorityHead(recordValue: StoredAuthorityRecord): ConversationHead {
  const head = decodeConversationHead(recordValue.value);
  if (head.revision !== recordValue.revision || head.ownerEpoch !== recordValue.fence) {
    return invalid(
      `Conversation head ${head.conversationId} disagrees with its authority envelope`,
    );
  }
  return head;
}

export function encodeCommandReceipt(value: CommandReceipt): Uint8Array {
  return jsonEncode(value);
}

export function decodeCommandReceipt(value: Uint8Array): CommandReceipt {
  const object = record(decodeJsonValue(value, "command receipt"), "command receipt");
  const logicalTurnId = object["logicalTurnId"];
  const executionId = object["executionId"];
  return {
    conversationId: text(object["conversationId"], "receipt.conversationId"),
    commandId: text(object["commandId"], "receipt.commandId"),
    commandDigest: text(object["commandDigest"], "receipt.commandDigest"),
    participantId: text(object["participantId"], "receipt.participantId"),
    acceptedAt: natural(object["acceptedAt"], "receipt.acceptedAt"),
    retainUntil: natural(object["retainUntil"], "receipt.retainUntil"),
    admittedRevision: counter(object["admittedRevision"], "receipt.admittedRevision"),
    resultingRevision: counter(object["resultingRevision"], "receipt.resultingRevision"),
    ...(logicalTurnId === undefined
      ? {}
      : { logicalTurnId: text(logicalTurnId, "receipt.logicalTurnId") }),
    ...(executionId === undefined ? {} : { executionId: text(executionId, "receipt.executionId") }),
  };
}

function validateCheckpointBounds(payload: Json, encodedBytes: number): void {
  const roots = checkpointHotRoots(payload);
  const sealed = checkpointHotSealedRootCount(payload);
  const payloadRecord =
    payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  const continuation = payloadRecord?.["continuation"];
  const continuationRecord =
    continuation !== null && typeof continuation === "object" && !Array.isArray(continuation)
      ? continuation
      : null;
  const openInterrupts = continuationRecord?.["openInterrupts"];
  assertCheckpointBounds({
    encodedBytes,
    totalRoots: roots.length,
    mutableRoots: roots.length - sealed,
    openInterrupts: Array.isArray(openInterrupts) ? openInterrupts.length : 0,
    largestInlineRootBytes: Math.max(
      0,
      ...roots.map(
        (root) => new TextEncoder().encode(canonicalSnapshot(root).canonical).byteLength,
      ),
    ),
  });
}

export function encodeCheckpoint(value: StoredCheckpoint): Uint8Array {
  assertCheckpointPayload(value.payload);
  const payload = canonicalSnapshot(value.payload);
  if (payload.sha !== value.contentHash) {
    return invalid(`Checkpoint ${value.checkpointId} content hash does not match payload`);
  }
  if (new TextEncoder().encode(payload.canonical).byteLength !== value.encodedBytes) {
    return invalid(`Checkpoint ${value.checkpointId} encoded byte count does not match payload`);
  }
  validateCheckpointBounds(value.payload, value.encodedBytes);
  return jsonEncode(value);
}

export function decodeCheckpoint(value: Uint8Array): StoredCheckpoint {
  const object = record(decodeJsonValue(value, "checkpoint"), "checkpoint");
  const payload = nullableJson(object["payload"], "checkpoint.payload");
  assertCheckpointPayload(payload);
  const result: StoredCheckpoint = {
    checkpointId: text(object["checkpointId"], "checkpoint.checkpointId"),
    conversationId: text(object["conversationId"], "checkpoint.conversationId"),
    causeKey: text(object["causeKey"], "checkpoint.causeKey"),
    cause: nullableJson(object["cause"], "checkpoint.cause"),
    contentHash: text(object["contentHash"], "checkpoint.contentHash"),
    archiveHead: historyPointer(object["archiveHead"], "checkpoint.archiveHead"),
    archiveThroughPosition: counter(
      object["archiveThroughPosition"],
      "checkpoint.archiveThroughPosition",
    ),
    payload,
    encodedBytes: natural(object["encodedBytes"], "checkpoint.encodedBytes"),
    createdAt: natural(object["createdAt"], "checkpoint.createdAt"),
  };
  const encoded = canonicalSnapshot(result.payload);
  if (encoded.sha !== result.contentHash) {
    return invalid(`Checkpoint ${result.checkpointId} content hash does not match payload`);
  }
  if (new TextEncoder().encode(encoded.canonical).byteLength !== result.encodedBytes) {
    return invalid(`Checkpoint ${result.checkpointId} encoded byte count is invalid`);
  }
  validateCheckpointBounds(result.payload, result.encodedBytes);
  return result;
}

function jsonArray(value: Json | undefined, field: string): readonly Json[] {
  return Array.isArray(value) ? value : invalid(`${field} must be an array`);
}

function validatePublicSegmentBounds(segment: StoredPublicArchiveSegment): void {
  const first = BigInt(counter(segment.firstPosition, "publicSegment.firstPosition"));
  const last = BigInt(counter(segment.lastPosition, "publicSegment.lastPosition"));
  if (last < first || last - first + 1n !== BigInt(segment.roots.length)) {
    return invalid(`Public archive segment ${segment.segmentId} has an invalid position range`);
  }
  const payloadBytes = rootPayloadBytes(segment.roots);
  const singletonLegal = segment.roots.length === 1 && payloadBytes <= 1024 * 1024;
  if (segment.roots.length > 100 || (payloadBytes > 1024 * 1024 && !singletonLegal)) {
    throw new ConversationStoreError(
      "segment_entry_too_large",
      `Public archive segment ${segment.segmentId} exceeds its production bound`,
    );
  }
}

export function encodePublicSegment(value: StoredPublicArchiveSegment): Uint8Array {
  validatePublicSegmentBounds(value);
  const encoded = canonicalSnapshot(value.roots);
  if (encoded.sha !== value.contentHash) {
    return invalid(`Public archive segment ${value.segmentId} content hash is invalid`);
  }
  if (new TextEncoder().encode(encoded.canonical).byteLength !== value.encodedBytes) {
    return invalid(`Public archive segment ${value.segmentId} encoded byte count is invalid`);
  }
  return jsonEncode(value);
}

export function decodePublicSegment(value: Uint8Array): StoredPublicArchiveSegment {
  const object = record(decodeJsonValue(value, "public archive segment"), "public archive segment");
  const result: StoredPublicArchiveSegment = {
    segmentId: text(object["segmentId"], "publicSegment.segmentId"),
    conversationId: text(object["conversationId"], "publicSegment.conversationId"),
    previous: historyPointer(object["previous"], "publicSegment.previous"),
    firstPosition: counter(object["firstPosition"], "publicSegment.firstPosition"),
    lastPosition: counter(object["lastPosition"], "publicSegment.lastPosition"),
    roots: jsonArray(object["roots"], "publicSegment.roots"),
    contentHash: text(object["contentHash"], "publicSegment.contentHash"),
    encodedBytes: natural(object["encodedBytes"], "publicSegment.encodedBytes"),
    createdAt: natural(object["createdAt"], "publicSegment.createdAt"),
  };
  const encoded = canonicalSnapshot(result.roots);
  if (encoded.sha !== result.contentHash) {
    return invalid(`Public archive segment ${result.segmentId} content hash is invalid`);
  }
  if (new TextEncoder().encode(encoded.canonical).byteLength !== result.encodedBytes) {
    return invalid(`Public archive segment ${result.segmentId} encoded byte count is invalid`);
  }
  validatePublicSegmentBounds(result);
  return result;
}

function validateTerminalRange(value: StoredTerminalSegment): void {
  const first = BigInt(counter(value.firstPosition, "terminalSegment.firstPosition"));
  const last = BigInt(counter(value.lastPosition, "terminalSegment.lastPosition"));
  if (last < first || last - first + 1n !== BigInt(value.entries.length)) {
    return invalid(`Terminal segment ${value.segmentId} has an invalid position range`);
  }
}

export function encodeTerminalSegment(value: StoredTerminalSegment): Uint8Array {
  validateTerminalRange(value);
  if (canonicalSnapshot(value.entries).sha !== value.contentHash) {
    return invalid(`Terminal segment ${value.segmentId} content hash is invalid`);
  }
  return jsonEncode(value);
}

export function decodeTerminalSegment(value: Uint8Array): StoredTerminalSegment {
  const object = record(decodeJsonValue(value, "terminal segment"), "terminal segment");
  const result: StoredTerminalSegment = {
    segmentId: text(object["segmentId"], "terminalSegment.segmentId"),
    conversationId: text(object["conversationId"], "terminalSegment.conversationId"),
    logicalTurnId: text(object["logicalTurnId"], "terminalSegment.logicalTurnId"),
    executionId: text(object["executionId"], "terminalSegment.executionId"),
    publicationKey: text(object["publicationKey"], "terminalSegment.publicationKey"),
    previous: historyPointer(object["previous"], "terminalSegment.previous"),
    firstPosition: counter(object["firstPosition"], "terminalSegment.firstPosition"),
    lastPosition: counter(object["lastPosition"], "terminalSegment.lastPosition"),
    entries: jsonArray(object["entries"], "terminalSegment.entries"),
    contentHash: text(object["contentHash"], "terminalSegment.contentHash"),
    createdAt: natural(object["createdAt"], "terminalSegment.createdAt"),
  };
  if (canonicalSnapshot(result.entries).sha !== result.contentHash) {
    return invalid(`Terminal segment ${result.segmentId} content hash is invalid`);
  }
  validateTerminalRange(result);
  return result;
}

export const conversationKeys = Object.freeze({
  head: (conversationId: string) => durableKey(conversationId),
  receipt: (conversationId: string, commandId: string) => durableKey(conversationId, commandId),
  checkpoint: (checkpointId: string) => durableKey(checkpointId),
  checkpointCause: (conversationId: string, causeKey: string) =>
    durableKey(conversationId, causeKey),
  publicSegment: (segmentId: string) => durableKey(segmentId),
  publicPosition: (conversationId: string, firstPosition: string, segmentId: string) =>
    durableKey(conversationId, firstPosition, segmentId),
  terminalSegment: (segmentId: string) => durableKey(segmentId),
  terminalPublication: (conversationId: string, publicationKey: string) =>
    durableKey(conversationId, publicationKey),
  terminalPosition: (conversationId: string, firstPosition: string, segmentId: string) =>
    durableKey(conversationId, firstPosition, segmentId),
});

export function immutableValue(recordValue: StoredImmutableRecord | null): Uint8Array | null {
  return recordValue?.value ?? null;
}
