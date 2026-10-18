import {
  durableKey,
  DURABLE_SCAN_MAX_BYTES,
  type StoredAuthorityRecord,
  type StoredImmutableRecord,
} from "@sweatpants/durable-storage-kernel";
import { assertJson, type Json, canonicalJson, sha256 } from "@sweatpants/foundation";
import { assertCheckpointBounds, CHECKPOINT_BOUNDS } from "./checkpoint-bounds.ts";
import { assertCheckpointPayload, checkpointHotRoots } from "./checkpoint-payload.ts";
import { rootPayloadBytes } from "./segmentation.ts";
import {
  ConversationStoreError,
  type ArchivedPublicRootIndex,
  type CommandReceipt,
  type ConversationHead,
  type StoredCheckpoint,
  type StoredPublicArchiveSegment,
  type StoredTerminalSegment,
} from "./contract.ts";

function invalid(message: string): never {
  throw new ConversationStoreError("persisted_data_invalid", message);
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

function publicArchivePointer(
  value: Json | undefined,
  label: string,
): { segmentId: string } | null {
  if (value === null) {
    return null;
  }
  const object = record(value ?? null, label);
  if (Object.keys(object).length !== 1) {
    return invalid(`${label} must contain only segmentId`);
  }
  return { segmentId: text(object["segmentId"], `${label}.segmentId`) };
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

export function readConversationHead(value: unknown): ConversationHead {
  const object = record(value, "conversation head");
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
  const head = readConversationHead(recordValue.value);
  if (head.revision !== recordValue.revision || head.ownerEpoch !== recordValue.fence) {
    return invalid(
      `Conversation head ${head.conversationId} disagrees with its authority envelope`,
    );
  }
  return head;
}

export function readCommandReceipt(value: unknown): CommandReceipt {
  const object = record(value, "command receipt");
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
    /* CONDITIONAL-SPREAD: Omit absent logicalTurnId from stored history and commit receipts; explicit undefined is not a portable JSON value. */
    ...(logicalTurnId === undefined
      ? {}
      : { logicalTurnId: text(logicalTurnId, "receipt.logicalTurnId") }),
    /* CONDITIONAL-SPREAD: Omit absent executionId from stored history and commit receipts; explicit undefined is not a portable JSON value. */
    ...(executionId === undefined ? {} : { executionId: text(executionId, "receipt.executionId") }),
  };
}

function validateCheckpointBounds(payload: Json, encodedBytes: number): void {
  const roots = checkpointHotRoots(payload);
  const mutable = roots.filter(
    (root) =>
      root !== null &&
      typeof root === "object" &&
      !Array.isArray(root) &&
      root["state"] === "mutable",
  ).length;
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
    mutableRoots: mutable,
    openInterrupts: Array.isArray(openInterrupts) ? openInterrupts.length : 0,
    // A root cannot exceed its enclosing canonical payload.
    largestInlineRootBytes:
      encodedBytes <= CHECKPOINT_BOUNDS.maxInlineRootBytes
        ? encodedBytes
        : Math.max(
            0,
            ...roots.map((root) => new TextEncoder().encode(canonicalJson(root)).byteLength),
          ),
  });
}

export function prepareCheckpoint(value: StoredCheckpoint): StoredCheckpoint {
  assertCheckpointPayload(value.payload);
  const payload = canonicalJson(value.payload);
  const payloadDigest = sha256(payload);
  if (payloadDigest !== value.contentHash) {
    return invalid(`Checkpoint ${value.checkpointId} content hash does not match payload`);
  }
  if (new TextEncoder().encode(payload).byteLength !== value.encodedBytes) {
    return invalid(`Checkpoint ${value.checkpointId} encoded byte count does not match payload`);
  }
  validateCheckpointBounds(value.payload, value.encodedBytes);
  // The payload owns the content identity; the storage envelope is ordinary JSON.
  return value;
}

export function readCheckpoint(value: unknown): StoredCheckpoint {
  const object = record(value, "checkpoint");
  const payload = nullableJson(object["payload"], "checkpoint.payload");
  assertCheckpointPayload(payload);
  const result: StoredCheckpoint = {
    checkpointId: text(object["checkpointId"], "checkpoint.checkpointId"),
    conversationId: text(object["conversationId"], "checkpoint.conversationId"),
    lineageId: text(object["lineageId"], "checkpoint.lineageId"),
    causeKey: text(object["causeKey"], "checkpoint.causeKey"),
    cause: nullableJson(object["cause"], "checkpoint.cause"),
    contentHash: text(object["contentHash"], "checkpoint.contentHash"),
    archiveHead: publicArchivePointer(object["archiveHead"], "checkpoint.archiveHead"),
    archiveFrontierOrdinal: counter(
      object["archiveFrontierOrdinal"],
      "checkpoint.archiveFrontierOrdinal",
    ),
    nextPublicPosition: counter(object["nextPublicPosition"], "checkpoint.nextPublicPosition"),
    payload,
    encodedBytes: natural(object["encodedBytes"], "checkpoint.encodedBytes"),
    createdAt: natural(object["createdAt"], "checkpoint.createdAt"),
  };
  const encoded = canonicalJson(result.payload);
  const encodedDigest = sha256(encoded);
  if (encodedDigest !== result.contentHash) {
    return invalid(`Checkpoint ${result.checkpointId} content hash does not match payload`);
  }
  if (new TextEncoder().encode(encoded).byteLength !== result.encodedBytes) {
    return invalid(`Checkpoint ${result.checkpointId} encoded byte count is invalid`);
  }
  validateCheckpointBounds(result.payload, result.encodedBytes);
  return result;
}

function jsonArray(value: Json | undefined, field: string): readonly Json[] {
  return Array.isArray(value) ? value : invalid(`${field} must be an array`);
}

function rootPosition(root: Json, label: string): bigint {
  const value = record(root, label);
  if (value["state"] !== "sealed") {
    return invalid(`${label} must be sealed before archival`);
  }
  return BigInt(counter(value["position"], `${label}.position`));
}

function validatePublicSegmentBounds(segment: StoredPublicArchiveSegment): void {
  if (segment.roots.length === 0) {
    return invalid(`Public archive segment ${segment.segmentId} must contain roots`);
  }
  const positions = segment.roots.map((root, index) =>
    rootPosition(root, `publicSegment.roots[${index}]`),
  );
  const unique = new Set(positions.map((position) => position.toString(10)));
  if (unique.size !== positions.length) {
    return invalid(`Public archive segment ${segment.segmentId} contains duplicate positions`);
  }
  const min = positions.reduce((left, right) => (left < right ? left : right));
  const max = positions.reduce((left, right) => (left > right ? left : right));
  if (
    min !== BigInt(counter(segment.minPosition, "publicSegment.minPosition")) ||
    max !== BigInt(counter(segment.maxPosition, "publicSegment.maxPosition"))
  ) {
    return invalid(`Public archive segment ${segment.segmentId} has invalid position metadata`);
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

export function preparePublicSegment(
  value: StoredPublicArchiveSegment,
): StoredPublicArchiveSegment {
  validatePublicSegmentBounds(value);
  const encoded = canonicalJson(value.roots);
  const encodedDigest = sha256(encoded);
  if (encodedDigest !== value.contentHash) {
    return invalid(`Public archive segment ${value.segmentId} content hash is invalid`);
  }
  if (new TextEncoder().encode(encoded).byteLength !== value.encodedBytes) {
    return invalid(`Public archive segment ${value.segmentId} encoded byte count is invalid`);
  }
  return value;
}

export function readPublicSegment(value: unknown): StoredPublicArchiveSegment {
  const object = record(value, "public archive segment");
  const result: StoredPublicArchiveSegment = {
    segmentId: text(object["segmentId"], "publicSegment.segmentId"),
    conversationId: text(object["conversationId"], "publicSegment.conversationId"),
    previous: publicArchivePointer(object["previous"], "publicSegment.previous"),
    minPosition: counter(object["minPosition"], "publicSegment.minPosition"),
    maxPosition: counter(object["maxPosition"], "publicSegment.maxPosition"),
    roots: jsonArray(object["roots"], "publicSegment.roots"),
    contentHash: text(object["contentHash"], "publicSegment.contentHash"),
    encodedBytes: natural(object["encodedBytes"], "publicSegment.encodedBytes"),
    createdAt: natural(object["createdAt"], "publicSegment.createdAt"),
  };
  const encoded = canonicalJson(result.roots);
  const encodedDigest = sha256(encoded);
  if (encodedDigest !== result.contentHash) {
    return invalid(`Public archive segment ${result.segmentId} content hash is invalid`);
  }
  if (new TextEncoder().encode(encoded).byteLength !== result.encodedBytes) {
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

export function prepareArchivedPublicRootIndex(
  value: ArchivedPublicRootIndex,
): ArchivedPublicRootIndex {
  counter(value.position, "publicRootIndex.position");
  counter(value.archiveOrdinal, "publicRootIndex.archiveOrdinal");
  if (!Number.isSafeInteger(value.segmentRootIndex) || value.segmentRootIndex < 0) {
    return invalid("publicRootIndex.segmentRootIndex must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(value.encodedBytes) || value.encodedBytes < 0) {
    return invalid("publicRootIndex.encodedBytes must be a non-negative safe integer");
  }
  return value;
}

export function readArchivedPublicRootIndex(value: unknown): ArchivedPublicRootIndex {
  const object = record(value, "public root index");
  const expected = new Set([
    "conversationId",
    "position",
    "rootId",
    "segmentId",
    "segmentRootIndex",
    "archiveOrdinal",
    "contentHash",
    "encodedBytes",
  ]);
  if (
    Object.keys(object).length !== expected.size ||
    Object.keys(object).some((key) => !expected.has(key))
  ) {
    return invalid("Public root index has an invalid persisted shape");
  }
  return {
    conversationId: text(object["conversationId"], "publicRootIndex.conversationId"),
    position: counter(object["position"], "publicRootIndex.position"),
    rootId: text(object["rootId"], "publicRootIndex.rootId"),
    segmentId: text(object["segmentId"], "publicRootIndex.segmentId"),
    segmentRootIndex: natural(object["segmentRootIndex"], "publicRootIndex.segmentRootIndex"),
    archiveOrdinal: counter(object["archiveOrdinal"], "publicRootIndex.archiveOrdinal"),
    contentHash: text(object["contentHash"], "publicRootIndex.contentHash"),
    encodedBytes: natural(object["encodedBytes"], "publicRootIndex.encodedBytes"),
  };
}

export function prepareTerminalSegment(value: StoredTerminalSegment): StoredTerminalSegment {
  validateTerminalRange(value);
  const encoded = canonicalJson(value.entries);
  if (new TextEncoder().encode(encoded).byteLength > DURABLE_SCAN_MAX_BYTES) {
    throw new ConversationStoreError(
      "segment_entry_too_large",
      `Terminal segment ${value.segmentId} exceeds the maximum readable segment payload`,
    );
  }
  if (sha256(encoded) !== value.contentHash) {
    return invalid(`Terminal segment ${value.segmentId} content hash is invalid`);
  }
  return value;
}

export function readTerminalSegment(value: unknown): StoredTerminalSegment {
  const object = record(value, "terminal segment");
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
  return prepareTerminalSegment(result);
}

export const conversationKeys = Object.freeze({
  head: (conversationId: string) => durableKey(conversationId),
  receipt: (conversationId: string, commandId: string) => durableKey(conversationId, commandId),
  checkpoint: (checkpointId: string) => durableKey(checkpointId),
  checkpointCause: (conversationId: string, causeKey: string) =>
    durableKey(conversationId, causeKey),
  publicSegment: (segmentId: string) => durableKey(segmentId),
  publicPosition: (conversationId: string, minPosition: string, segmentId: string) =>
    durableKey(conversationId, minPosition, segmentId),
  publicRootIndex: (conversationId: string, position: string) =>
    durableKey(conversationId, position),
  publicRootIdentity: (conversationId: string, rootId: string) =>
    durableKey(conversationId, "root", rootId),
  terminalSegment: (segmentId: string) => durableKey(segmentId),
  terminalPublication: (conversationId: string, publicationKey: string) =>
    durableKey(conversationId, publicationKey),
  terminalPosition: (conversationId: string, firstPosition: string, segmentId: string) =>
    durableKey(conversationId, firstPosition, segmentId),
});

export function immutableValue(recordValue: StoredImmutableRecord | null): unknown {
  return recordValue?.value ?? null;
}
