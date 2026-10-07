import {
  sqlNatural as numberValue,
  type SqlNumbers,
  invalidStoredSqlValue as invalid,
  priorSqlPosition as priorPosition,
} from "@sweatpants/durable-storage-kernel";
import { canonicalJson, cloneJson, parseJsonText } from "@sweatpants/foundation";
import type {
  ExecutionControl,
  StoredExecutionObject,
  StoredPrivateSegment,
} from "./store/store.ts";
import {
  decodeExecutionControlJson,
  encodePrivateSegmentEnvelopeFromCanonical,
} from "./store/store-persistence.ts";
type ControlRow = SqlNumbers<
  Omit<ExecutionControl, "status" | "requestedDisposition" | "control">
> & { status: string; requestedDisposition: string | null; controlJson: string };
type PrivateRow = SqlNumbers<Omit<StoredPrivateSegment, "previous" | "entries">> & {
  previousSegmentId: string | null;
  entriesJson: string;
};
type ObjectRow = SqlNumbers<Omit<StoredExecutionObject, "lifetimeScope" | "body">> & {
  lifetimeScope: string;
  jsonBody: string | null;
  blobBody: Uint8Array | null;
};
export function controlFromRow(row: ControlRow): ExecutionControl {
  return decodeExecutionControlJson(
    cloneJson({
      executionId: row.executionId,
      controlRevision: row.controlRevision,
      ownerFence: row.ownerFence,
      status: row.status as ExecutionControl["status"],
      rootTaskId: row.rootTaskId,
      stopGeneration: row.stopGeneration,
      requestedDisposition: row.requestedDisposition as ExecutionControl["requestedDisposition"],
      control: parseJsonText(row.controlJson, "control_json"),
      updatedAt: numberValue(row.updatedAt, "updated_at"),
    }),
  );
}
export function privateEnvelopeFromRow(row: PrivateRow): Uint8Array {
  return encodePrivateSegmentEnvelopeFromCanonical(
    {
      segmentId: row.segmentId,
      executionId: row.executionId,
      taskId: row.taskId,
      previous:
        row.previousSegmentId === null
          ? null
          : { segmentId: row.previousSegmentId, lastSequence: priorPosition(row.firstSequence) },
      firstSequence: row.firstSequence,
      lastSequence: row.lastSequence,
      contentHash: row.contentHash,
      encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
      createdAt: numberValue(row.createdAt, "created_at"),
    },
    row.entriesJson,
  );
}
export function objectFromRow(row: ObjectRow): StoredExecutionObject {
  if ((row.jsonBody === null) === (row.blobBody === null)) {
    return invalid(`Execution object ${row.objectId} has invalid body cardinality`);
  }
  const value: StoredExecutionObject = {
    objectId: row.objectId,
    lifetimeScope: row.lifetimeScope as StoredExecutionObject["lifetimeScope"],
    scopeOwnerId: row.scopeOwnerId,
    objectKind: row.objectKind,
    contentHash: row.contentHash,
    byteLength: numberValue(row.byteLength, "byte_length"),
    body:
      row.jsonBody === null
        ? new Uint8Array(row.blobBody!)
        : parseJsonText(row.jsonBody, "json_body"),
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}
export function privateToRow(value: StoredPrivateSegment) {
  const entriesJson = canonicalJson(value.entries);
  return {
    segmentId: value.segmentId,
    executionId: value.executionId,
    taskId: value.taskId,
    previousSegmentId: value.previous?.segmentId ?? null,
    firstSequence: value.firstSequence,
    lastSequence: value.lastSequence,
    entriesJson,
    contentHash: value.contentHash,
    encodedBytes: value.encodedBytes,
    createdAt: value.createdAt,
    storedBytes:
      encodePrivateSegmentEnvelopeFromCanonical(value, "").byteLength + value.encodedBytes,
  };
}
export function objectToRow(value: StoredExecutionObject) {
  const binary = value.body instanceof Uint8Array;
  return {
    objectId: value.objectId,
    lifetimeScope: value.lifetimeScope,
    scopeOwnerId: value.scopeOwnerId,
    objectKind: value.objectKind,
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    jsonBody: binary ? null : canonicalJson(value.body),
    blobBody: binary ? value.body : null,
    createdAt: value.createdAt,
  };
}

export function controlToRow(value: ExecutionControl) {
  return {
    controlRevision: value.controlRevision,
    ownerFence: value.ownerFence,
    status: value.status,
    rootTaskId: value.rootTaskId,
    stopGeneration: value.stopGeneration,
    requestedDisposition: value.requestedDisposition,
    controlJson: canonicalJson(value.control),
    updatedAt: value.updatedAt,
  };
}
