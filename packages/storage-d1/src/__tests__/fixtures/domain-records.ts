import { canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import { durableKey } from "@sweatpants/durable-storage-kernel";

export function controlValue(
  executionId: string,
  revision: string,
  fence = "0",
  control: Json = null,
) {
  const value = {
    executionId,
    controlRevision: revision,
    ownerFence: fence,
    status: "active" as const,
    rootTaskId: "root",
    stopGeneration: "0",
    requestedDisposition: null,
    control,
    updatedAt: 1,
  };
  return { value };
}
export function headValue(conversationId: string, revision = "0", activeSegment: Json = null) {
  const value = {
    conversationId,
    revision,
    ownerEpoch: "0",
    ownerRoute: null,
    state: "idle" as const,
    checkpoint: null,
    terminalHistory: null,
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: null,
    activeSegment,
    activeCommand: null,
    deletedAt: null,
    updatedAt: 1,
  };
  return { value };
}
export function objectEnsure(id: string, body: Json, name = "object") {
  const encoded = canonicalJson(body);
  const value = {
    objectId: id,
    lifetimeScope: "execution" as const,
    scopeOwnerId: "test",
    objectKind: "fixture",
    contentHash: sha256(encoded),
    byteLength: new TextEncoder().encode(encoded).byteLength,
    body,
    createdAt: 1,
  };
  return {
    name,
    collection: "execution-objects" as const,
    key: durableKey(id),
    fingerprint: value.contentHash,
    value,
  };
}
export function checkpointEnsure(
  id: string,
  conversationId: string,
  causeKey: string,
  body: Json,
  name = "checkpoint",
) {
  const payload = { public: { hotRoots: [], applicationState: body } };
  const encoded = canonicalJson(payload);
  const value = {
    checkpointId: id,
    conversationId,
    lineageId: "lineage",
    causeKey,
    cause: null,
    contentHash: sha256(encoded),
    archiveHead: null,
    archiveFrontierOrdinal: "0",
    nextPublicPosition: "0",
    payload,
    encodedBytes: new TextEncoder().encode(encoded).byteLength,
    createdAt: 1,
  };
  return {
    name,
    collection: "conversation-checkpoints" as const,
    key: durableKey(id),
    alternateKeys: [durableKey(conversationId, causeKey)],
    fingerprint: value.contentHash,
    value,
  };
}
export function receiptClaim(conversationId: string, commandId: string, name = "claim") {
  const value = {
    conversationId,
    commandId,
    commandDigest: "same",
    participantId: "test",
    acceptedAt: 1,
    retainUntil: 2,
    admittedRevision: "0",
    resultingRevision: "1",
  };
  return {
    name,
    collection: "conversation-command-receipts" as const,
    key: durableKey(conversationId, commandId),
    fingerprint: value.commandDigest,
    value,
  };
}
export function publicEnsure(conversationId: string, position: string, body: Json = null) {
  const segmentId = `${conversationId}-${position}`;
  const roots = [{ rootId: segmentId, position, state: "sealed", kind: "message", payload: body }];
  const encoded = canonicalJson(roots);
  const value = {
    segmentId,
    conversationId,
    previous: null,
    minPosition: position,
    maxPosition: position,
    roots,
    contentHash: sha256(encoded),
    encodedBytes: new TextEncoder().encode(encoded).byteLength,
    createdAt: 1,
  };
  return {
    name: "segment",
    collection: "conversation-public-segments" as const,
    key: durableKey(segmentId),
    alternateKeys: [durableKey(conversationId, position, segmentId)],
    fingerprint: value.contentHash,
    value,
  };
}
