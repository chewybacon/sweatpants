import {
  sqlNatural as numberValue,
  type SqlNumbers,
  priorSqlPosition as priorPosition,
} from "@sweatpants/durable-storage-kernel";
import type { Json } from "@sweatpants/foundation";
import type {
  ExecutionControl,
  StoredExecutionObject,
  StoredPrivateSegment,
} from "./store/store.ts";
import { readExecutionControl } from "./store/store-persistence.ts";
type ControlRow = SqlNumbers<
  Omit<ExecutionControl, "status" | "requestedDisposition" | "control">
> & { status: string; requestedDisposition: string | null; controlJson: Json };
type PrivateRow = SqlNumbers<Omit<StoredPrivateSegment, "previous" | "entries">> & {
  previousSegmentId: string | null;
  entriesJson: readonly Json[];
};
type ObjectRow = SqlNumbers<Omit<StoredExecutionObject, "lifetimeScope" | "body">> & {
  lifetimeScope: string;
  jsonBody: Json;
};
export function controlFromRow(row: ControlRow): ExecutionControl {
  const metadata = {
    executionId: row.executionId,
    controlRevision: row.controlRevision,
    ownerFence: row.ownerFence,
    status: row.status,
    rootTaskId: row.rootTaskId,
    stopGeneration: row.stopGeneration,
    requestedDisposition: row.requestedDisposition,
    updatedAt: numberValue(row.updatedAt, "updated_at"),
  };
  return readExecutionControl({
    ...metadata,
    control: row.controlJson,
  });
}
export function privateFromRow(row: PrivateRow): StoredPrivateSegment {
  return {
    segmentId: row.segmentId,
    executionId: row.executionId,
    taskId: row.taskId,
    previous:
      row.previousSegmentId === null
        ? null
        : {
            segmentId: row.previousSegmentId,
            lastSequence: priorPosition(row.firstSequence),
          },
    firstSequence: row.firstSequence,
    lastSequence: row.lastSequence,
    contentHash: row.contentHash,
    encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
    createdAt: numberValue(row.createdAt, "created_at"),
    entries: row.entriesJson as StoredPrivateSegment["entries"],
  };
}
export function objectFromRow(row: ObjectRow): StoredExecutionObject {
  const value: StoredExecutionObject = {
    objectId: row.objectId,
    lifetimeScope: row.lifetimeScope as StoredExecutionObject["lifetimeScope"],
    scopeOwnerId: row.scopeOwnerId,
    objectKind: row.objectKind,
    contentHash: row.contentHash,
    byteLength: numberValue(row.byteLength, "byte_length"),
    body: row.jsonBody,
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}
export function privateToRow(value: StoredPrivateSegment) {
  return {
    segmentId: value.segmentId,
    executionId: value.executionId,
    taskId: value.taskId,
    previousSegmentId: value.previous?.segmentId ?? null,
    firstSequence: value.firstSequence,
    lastSequence: value.lastSequence,
    entriesJson: value.entries,
    contentHash: value.contentHash,
    encodedBytes: value.encodedBytes,
    createdAt: value.createdAt,
  };
}
export function objectToRow(value: StoredExecutionObject) {
  return {
    objectId: value.objectId,
    lifetimeScope: value.lifetimeScope,
    scopeOwnerId: value.scopeOwnerId,
    objectKind: value.objectKind,
    contentHash: value.contentHash,
    byteLength: value.byteLength,
    jsonBody: value.body,
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
    controlJson: value.control,
    updatedAt: value.updatedAt,
  };
}
