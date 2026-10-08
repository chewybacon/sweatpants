import { CrankError } from "@sweatpants/durable-execution";
import {
  failure,
  success,
  type ParseResult,
  type Parser,
  canonicalDigest,
} from "@sweatpants/foundation";
import {
  DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES,
  durableAuthoritySnapshotStructureParser,
  durableAuthoritySnapshotBoundsParser,
  MAX_RECORDS_PER_SESSION,
} from "./durable-authority-snapshot-schema.ts";
import { retainedValueBounds } from "../state/accepted-values.ts";
import type { DurableAuthoritySnapshot } from "../state/authority-snapshot.ts";

export { DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES } from "./durable-authority-snapshot-schema.ts";

const verifiedRequests = new WeakSet<object>();
const verifiedSettlements = new WeakSet<object>();

export const durableAuthoritySnapshotParser: Parser<DurableAuthoritySnapshot> =
  durableAuthoritySnapshotStructureParser.andThen(verifyDurableAuthoritySnapshot);

function verifyDurableAuthoritySnapshot(value: unknown): ParseResult<DurableAuthoritySnapshot> {
  const snapshot = value as DurableAuthoritySnapshot;
  const sessions = new Set<string>();
  for (const [sessionIndex, [sessionId, session]] of snapshot.sessions.entries()) {
    if (sessions.has(sessionId))
      return snapshotFailure(["sessions", sessionIndex], "session is duplicated");
    sessions.add(sessionId);
    if (
      session.control.activationLease?.sessionId !== undefined &&
      session.control.activationLease.sessionId !== sessionId
    ) {
      return snapshotFailure(
        ["sessions", sessionIndex, 1, "control", "activationLease"],
        "lease session does not match its key",
      );
    }
    const tasks = new Set<string>();
    for (const [taskIndex, task] of session.execution.tasks.entries()) {
      const path = ["sessions", sessionIndex, 1, "execution", "tasks", taskIndex] as const;
      if (tasks.has(task.taskId)) return snapshotFailure(path, "task is duplicated");
      tasks.add(task.taskId);
      if (
        task.program.artifact.id !== task.program.manifest.programId ||
        task.program.artifact.version !== task.program.manifest.version ||
        task.program.artifact.digest !== task.program.manifest.digest
      )
        return snapshotFailure(path, "artifact and manifest differ");
      if ((task.execution.catalog === undefined) !== (task.execution.catalogDigest === undefined)) {
        return snapshotFailure(path, "catalog and catalog digest must be supplied together");
      }
      if (task.lifecycle.status === "cancelled" && task.lifecycle.outcome.status !== "cancelled") {
        return snapshotFailure(path, "task lifecycle is invalid");
      }
      let pullIndex = 0;
      let emissionIndex = 0;
      for (const [actionIndex, action] of task.actions.entries()) {
        if (action.actionIndex !== actionIndex)
          return snapshotFailure(path, "action indexes have a gap");
        if (action.kind === "pull") {
          if (action.pullIndex !== pullIndex++)
            return snapshotFailure(path, "pull indexes have a gap");
          if (
            !verifiedRequests.has(action.pull.request) &&
            (action.pull.request.proposedDescriptorDigest !==
              canonicalDigest(action.pull.request.proposedDescriptor) ||
              action.pull.request.resultSchemaDigest !==
                (action.pull.request.resultDescriptor as unknown as Record<string, unknown>)[
                  "digest"
                ])
          )
            return snapshotFailure(path, "pull integrity relationship is invalid");
          verifiedRequests.add(action.pull.request);
          if (
            action.pull.resolution.status === "settled" &&
            !verifiedSettlements.has(action) &&
            action.pull.resolution.settlement.outcomeDigest !==
              canonicalDigest(action.pull.resolution.settlement.outcome)
          )
            return snapshotFailure(path, "pull settlement digest differs");
          if (action.pull.resolution.status === "settled") verifiedSettlements.add(action);
        } else if (action.emissionIndex !== emissionIndex++) {
          return snapshotFailure(path, "emission indexes have a gap");
        }
      }
      if (task.nextActionIndex > task.actions.length || task.nextPullIndex < pullIndex) {
        return snapshotFailure(path, "action cursor is invalid");
      }
    }
  }
  for (const [groupIndex, recordGroup] of snapshot.records.entries()) {
    for (const [recordIndex, record] of recordGroup[1].entries()) {
      const payload = record.payload;
      if (
        payload.type === "TaskOpened" &&
        ((payload.catalog === undefined) !== (payload.catalogDigest === undefined) ||
          (payload.parentTaskId === undefined) !== (payload.parentPullId === undefined))
      ) {
        return snapshotFailure(
          ["records", groupIndex, 1, recordIndex, "payload"],
          "task-open relationships are invalid",
        );
      }
    }
  }
  return success(snapshot);
}

function snapshotFailure(path: readonly (string | number)[], detail: string): ParseResult<never> {
  return failure({ path, message: `invalid durable authority snapshot: ${detail}` });
}

export function parseDurableAuthoritySnapshot(serialized: string): DurableAuthoritySnapshot {
  try {
    if (new TextEncoder().encode(serialized).byteLength > DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES) {
      throw invalidSnapshot();
    }
    return decodeDurableAuthoritySnapshot(JSON.parse(serialized) as unknown);
  } catch (error) {
    if (error instanceof CrankError && error.code === "invalid_journal") throw error;
    throw invalidSnapshot();
  }
}

/** Validate an already decoded value; the storage/text boundary owns the byte limit. */
export function decodeDurableAuthoritySnapshot(value: unknown): DurableAuthoritySnapshot {
  try {
    const parsed = durableAuthoritySnapshotParser.parse(value);
    if (!parsed.ok) throw invalidSnapshot();
    return parsed.value;
  } catch (error) {
    if (error instanceof CrankError && error.code === "invalid_journal") throw error;
    throw invalidSnapshot();
  }
}

function invalidSnapshot(): CrankError {
  return new CrankError("invalid_journal", "Invalid durable authority snapshot");
}

// Byte sizes belong to privately retained immutable records, never caller graphs.
const retainedRecordBytes = new WeakMap<object, number>();

/** Check aggregate limits for privately owned records whose shapes are already validated. */
export function validateJournalCollectionBounds(
  sessionId: string,
  records: readonly import("../contract/semantic-record.ts").DurableSemanticRecord[],
): void {
  const snapshot = { version: 1, sessions: [], nextNonce: 0, records: [[sessionId, records]] };
  if (
    records.length > MAX_RECORDS_PER_SESSION ||
    !durableAuthoritySnapshotBoundsParser.parse(snapshot).ok
  ) {
    throw invalidSnapshot();
  }
  const encoder = new TextEncoder();
  const empty = { ...snapshot, records: [[sessionId, []]] };
  let bytes = encoder.encode(JSON.stringify(empty)).byteLength + Math.max(0, records.length - 1);
  if (bytes > DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES) throw invalidSnapshot();
  for (const record of records) {
    let size = retainedRecordBytes.get(record);
    if (size === undefined) {
      size = encoder.encode(JSON.stringify(record)).byteLength;
      if (retainedValueBounds(record)) retainedRecordBytes.set(record, size);
    }
    bytes += size;
    if (bytes > DURABLE_AUTHORITY_MAX_SNAPSHOT_BYTES) throw invalidSnapshot();
  }
}
