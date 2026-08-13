import {
  DurableCollections,
  DurableIndexes,
  authorityMismatch,
  decodeDurableKey,
  decodeJsonValue,
  validateMutationStructure,
  validateScan,
  type AuthorityCollectionId,
  type BoundedScan,
  type DurableKernel,
  type DurableMutation,
  type DurableMutationOutcome,
  type ImmutableCollectionId,
  type StoredAuthorityRecord,
  type StoredImmutableRecord,
  type StoredScanPage,
} from "@sweatpants/durable-storage-kernel";
import { canonicalJson, parseJsonText, type Json } from "@sweatpants/foundation";
import {
  conversationKeys,
  decodeCheckpoint,
  decodeCommandReceipt,
  decodeConversationHead,
  decodePublicSegment,
  decodeTerminalSegment,
  encodeCheckpoint,
  encodeCommandReceipt,
  encodeConversationHead,
  encodePublicSegment,
  encodeTerminalSegment,
} from "@sweatpants/history-store/persistence";
import type {
  CommandReceipt,
  ConversationHead,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
} from "@sweatpants/history-store/contract";
import {
  decodeExecutionControl,
  decodeExecutionObject,
  decodePrivateSegment,
  encodeExecutionControl,
  encodeExecutionObjectEnvelope,
  encodePrivateSegmentEnvelopeFromCanonical,
  executionKeys,
} from "@sweatpants/journal-authority/store-persistence";
import type {
  ExecutionControl,
  StoredExecutionObject,
} from "@sweatpants/journal-authority/store";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { call, sleep, type Operation } from "effection";
import { StorageError } from "./contract.ts";
import {
  spConversationCheckpoints,
  spConversationCommandReceipts,
  spConversationHeads,
  spConversationPublicSegments,
  spConversationTerminalSegments,
  spExecutionControl,
  spExecutionJournalSegments,
  spExecutionObjects,
  spExecutionReplaySegments,
  type SqliteSchema,
} from "./schema.ts";

export type SQLiteResultKind = "sync" | "async";
export type SweatpantsSqliteDatabase<
  TResultKind extends SQLiteResultKind = SQLiteResultKind,
  TRunResult = unknown,
> = BaseSQLiteDatabase<TResultKind, TRunResult, SqliteSchema>;

export interface SqliteImmediateTransactions<TDatabase> {
  immediate<T>(body: (transaction: TDatabase) => T | Promise<T>): Operation<T>;
}

type Database = SweatpantsSqliteDatabase<SQLiteResultKind, unknown>;
type HeadRow = typeof spConversationHeads.$inferSelect;
type ReceiptRow = typeof spConversationCommandReceipts.$inferSelect;
type CheckpointRow = typeof spConversationCheckpoints.$inferSelect;
type PublicRow = typeof spConversationPublicSegments.$inferSelect;
type TerminalRow = typeof spConversationTerminalSegments.$inferSelect;
type ControlRow = typeof spExecutionControl.$inferSelect;
type PrivateRow = typeof spExecutionJournalSegments.$inferSelect;
type ObjectRow = typeof spExecutionObjects.$inferSelect;

async function resolved<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

function invalid(message: string): never {
  throw new StorageError("persisted_data_invalid", message);
}

function numberValue(value: number | bigint, field: string): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : invalid(`${field} is outside the safe integer range`);
}

function nullableJson(value: string | null, field: string): Json | null {
  return value === null ? null : parseJsonText(value, field);
}

function requireKey(key: string, lengths: readonly number[]): readonly string[] {
  const parts = decodeDurableKey(key);
  if (!lengths.includes(parts.length)) {
    throw new StorageError("persisted_data_invalid", `Unexpected durable key shape ${key}`);
  }
  return parts;
}

async function selectHead(database: Database, conversationId: string): Promise<HeadRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationHeads)
      .where(eq(spConversationHeads.conversationId, conversationId))
      .get() as HeadRow | undefined | Promise<HeadRow | undefined>,
  );
}

async function selectTerminal(database: Database, segmentId: string): Promise<TerminalRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationTerminalSegments)
      .where(eq(spConversationTerminalSegments.segmentId, segmentId))
      .get() as TerminalRow | undefined | Promise<TerminalRow | undefined>,
  );
}

async function headFromRow(database: Database, row: HeadRow): Promise<ConversationHead> {
  const terminal =
    row.terminalSegmentId === null ? undefined : await selectTerminal(database, row.terminalSegmentId);
  if (row.terminalSegmentId !== null && terminal === undefined) {
    return invalid(`Head ${row.conversationId} points to missing terminal segment`);
  }
  return decodeConversationHead(
    encodeConversationHead({
      conversationId: row.conversationId,
      revision: row.revision,
      ownerEpoch: row.ownerEpoch,
      ownerRoute: nullableJson(row.ownerRouteJson, "owner_route_json"),
      state: row.state as ConversationHead["state"],
      checkpoint: row.checkpointId === null ? null : { checkpointId: row.checkpointId },
      terminalHistory:
        row.terminalSegmentId === null
          ? null
          : { segmentId: row.terminalSegmentId, lastPosition: terminal!.lastPosition },
      activeLogicalTurnId: row.activeLogicalTurnId,
      activeExecutionId: row.activeExecutionId,
      latestCompletedExecutionId: row.latestCompletedExecutionId,
      activeSegment: nullableJson(row.activeSegmentJson, "active_segment_json"),
      activeCommand: nullableJson(row.activeCommandJson, "active_command_json"),
      deletedAt: row.deletedAt === null ? null : numberValue(row.deletedAt, "deleted_at"),
      updatedAt: numberValue(row.updatedAt, "updated_at"),
    }),
  );
}

async function selectControl(database: Database, executionId: string): Promise<ControlRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spExecutionControl)
      .where(eq(spExecutionControl.executionId, executionId))
      .get() as ControlRow | undefined | Promise<ControlRow | undefined>,
  );
}

function controlFromRow(row: ControlRow): ExecutionControl {
  return decodeExecutionControl(
    encodeExecutionControl({
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

async function readAuthorityIn(
  database: Database,
  collection: AuthorityCollectionId,
  key: string,
): Promise<StoredAuthorityRecord | null> {
  const [id] = requireKey(key, [1]);
  if (collection === DurableCollections.conversationHeads) {
    const row = await selectHead(database, id!);
    if (!row) {
      return null;
    }
    const head = await headFromRow(database, row);
    return { collection, key, revision: head.revision, fence: head.ownerEpoch, value: encodeConversationHead(head) };
  }
  const row = await selectControl(database, id!);
  if (!row) {
    return null;
  }
  const control = controlFromRow(row);
  return { collection, key, revision: control.controlRevision, fence: control.ownerFence, value: encodeExecutionControl(control) };
}

function receiptFromRow(row: ReceiptRow): CommandReceipt {
  return {
    conversationId: row.conversationId,
    commandId: row.commandId,
    commandDigest: row.commandDigest,
    participantId: row.participantId,
    acceptedAt: numberValue(row.acceptedAt, "accepted_at"),
    retainUntil: numberValue(row.retainUntil, "retain_until"),
    admittedRevision: row.admittedRevision,
    resultingRevision: row.resultingRevision,
    ...(row.logicalTurnId === null ? {} : { logicalTurnId: row.logicalTurnId }),
    ...(row.executionId === null ? {} : { executionId: row.executionId }),
  };
}

function checkpointFromRow(row: CheckpointRow): StoredCheckpoint {
  const value: StoredCheckpoint = {
    checkpointId: row.checkpointId,
    conversationId: row.conversationId,
    causeKey: row.causeKey,
    cause: parseJsonText(row.causeJson, "cause_json"),
    contentHash: row.contentHash,
    archiveHead:
      row.archiveHeadSegmentId === null
        ? null
        : { segmentId: row.archiveHeadSegmentId, lastPosition: row.archiveThroughPosition },
    archiveThroughPosition: row.archiveThroughPosition,
    payload: parseJsonText(row.payloadJson, "payload_json"),
    encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}

function priorPosition(first: string): string {
  return (BigInt(first) > 0n ? BigInt(first) - 1n : 0n).toString(10);
}

function publicFromRow(row: PublicRow): StoredPublicArchiveSegment {
  const value: StoredPublicArchiveSegment = {
    segmentId: row.segmentId,
    conversationId: row.conversationId,
    previous:
      row.previousSegmentId === null
        ? null
        : { segmentId: row.previousSegmentId, lastPosition: priorPosition(row.firstPosition) },
    firstPosition: row.firstPosition,
    lastPosition: row.lastPosition,
    roots: parseJsonText(row.rootsJson, "roots_json") as readonly Json[],
    contentHash: row.contentHash,
    encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}

function terminalFromRow(row: TerminalRow): StoredTerminalSegment {
  const value: StoredTerminalSegment = {
    segmentId: row.segmentId,
    conversationId: row.conversationId,
    logicalTurnId: row.logicalTurnId,
    executionId: row.executionId,
    publicationKey: row.publicationKey,
    previous:
      row.previousSegmentId === null
        ? null
        : { segmentId: row.previousSegmentId, lastPosition: priorPosition(row.firstPosition) },
    firstPosition: row.firstPosition,
    lastPosition: row.lastPosition,
    entries: parseJsonText(row.entriesJson, "entries_json") as readonly Json[],
    contentHash: row.contentHash,
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}

function privateEnvelopeFromRow(row: PrivateRow): Uint8Array {
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

function objectFromRow(row: ObjectRow): StoredExecutionObject {
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

function immutableRecord(
  collection: ImmutableCollectionId,
  key: string,
  fingerprint: string,
  value: Uint8Array,
): StoredImmutableRecord {
  return { collection, key, fingerprint, value };
}

async function readImmutableIn(
  database: Database,
  collection: ImmutableCollectionId,
  key: string,
): Promise<StoredImmutableRecord | null> {
  const parts = decodeDurableKey(key);
  switch (collection) {
    case DurableCollections.conversationCommandReceipts: {
      const [conversationId, commandId] = requireKey(key, [2]);
      const row = await resolved(database.select().from(spConversationCommandReceipts).where(and(eq(spConversationCommandReceipts.conversationId, conversationId!), eq(spConversationCommandReceipts.commandId, commandId!))).get() as ReceiptRow | undefined | Promise<ReceiptRow | undefined>);
      if (!row) {
        return null;
      }
      const value = receiptFromRow(row);
      return immutableRecord(collection, conversationKeys.receipt(value.conversationId, value.commandId), value.commandDigest, encodeCommandReceipt(value));
    }
    case DurableCollections.conversationCheckpoints: {
      const row = await resolved(
        (parts.length === 1
          ? database.select().from(spConversationCheckpoints).where(eq(spConversationCheckpoints.checkpointId, parts[0]!))
          : database.select().from(spConversationCheckpoints).where(and(eq(spConversationCheckpoints.conversationId, parts[0]!), eq(spConversationCheckpoints.causeKey, parts[1]!))))
          .get() as CheckpointRow | undefined | Promise<CheckpointRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const value = checkpointFromRow(row);
      return immutableRecord(collection, conversationKeys.checkpoint(value.checkpointId), value.contentHash, encodeCheckpoint(value));
    }
    case DurableCollections.conversationPublicSegments: {
      const row = await resolved(
        (parts.length === 1
          ? database.select().from(spConversationPublicSegments).where(eq(spConversationPublicSegments.segmentId, parts[0]!))
          : database.select().from(spConversationPublicSegments).where(and(eq(spConversationPublicSegments.conversationId, parts[0]!), eq(spConversationPublicSegments.firstPosition, parts[1]!), eq(spConversationPublicSegments.segmentId, parts[2]!))))
          .get() as PublicRow | undefined | Promise<PublicRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const value = publicFromRow(row);
      return immutableRecord(collection, conversationKeys.publicSegment(value.segmentId), value.contentHash, encodePublicSegment(value));
    }
    case DurableCollections.conversationTerminalSegments: {
      const where =
        parts.length === 1
          ? eq(spConversationTerminalSegments.segmentId, parts[0]!)
          : parts.length === 2
            ? and(eq(spConversationTerminalSegments.conversationId, parts[0]!), eq(spConversationTerminalSegments.publicationKey, parts[1]!))
            : and(eq(spConversationTerminalSegments.conversationId, parts[0]!), eq(spConversationTerminalSegments.firstPosition, parts[1]!), eq(spConversationTerminalSegments.segmentId, parts[2]!));
      const row = await resolved(database.select().from(spConversationTerminalSegments).where(where).get() as TerminalRow | undefined | Promise<TerminalRow | undefined>);
      if (!row) {
        return null;
      }
      const value = terminalFromRow(row);
      return immutableRecord(collection, conversationKeys.terminalSegment(value.segmentId), value.contentHash, encodeTerminalSegment(value));
    }
    case DurableCollections.executionJournalSegments:
    case DurableCollections.executionReplaySegments: {
      const table = collection === DurableCollections.executionJournalSegments ? spExecutionJournalSegments : spExecutionReplaySegments;
      const where = parts.length === 1
        ? eq(table.segmentId, parts[0]!)
        : and(
            eq(table.executionId, parts[0]!),
            eq(table.taskId, parts[1]!),
            eq(table.firstSequence, parts[2]!),
            eq(table.lastSequence, parts[3]!),
          );
      const row = await resolved(database.select().from(table).where(where).get() as PrivateRow | undefined | Promise<PrivateRow | undefined>);
      if (!row) {
        return null;
      }
      return immutableRecord(
        collection,
        executionKeys.segment(row.segmentId),
        row.contentHash,
        privateEnvelopeFromRow(row),
      );
    }
    case DurableCollections.executionObjects: {
      const [objectId] = requireKey(key, [1]);
      const row = await resolved(database.select().from(spExecutionObjects).where(eq(spExecutionObjects.objectId, objectId!)).get() as ObjectRow | undefined | Promise<ObjectRow | undefined>);
      if (!row) {
        return null;
      }
      const value = objectFromRow(row);
      return immutableRecord(
        collection,
        executionKeys.object(value.objectId),
        value.contentHash,
        encodeExecutionObjectEnvelope(value),
      );
    }
  }
}

async function insertImmutable(database: Database, record: { collection: ImmutableCollectionId; value: Uint8Array }): Promise<void> {
  switch (record.collection) {
    case DurableCollections.conversationCommandReceipts: {
      const value = decodeCommandReceipt(record.value);
      await resolved(database.insert(spConversationCommandReceipts).values({
        conversationId: value.conversationId, commandId: value.commandId, commandDigest: value.commandDigest,
        participantId: value.participantId, acceptedAt: value.acceptedAt, retainUntil: value.retainUntil,
        admittedRevision: value.admittedRevision, resultingRevision: value.resultingRevision,
        logicalTurnId: value.logicalTurnId ?? null, executionId: value.executionId ?? null,
      }).run());
      return;
    }
    case DurableCollections.conversationCheckpoints: {
      const value = decodeCheckpoint(record.value);
      await resolved(database.insert(spConversationCheckpoints).values({
        checkpointId: value.checkpointId, conversationId: value.conversationId, causeKey: value.causeKey,
        causeJson: canonicalJson(value.cause), contentHash: value.contentHash,
        archiveHeadSegmentId: value.archiveHead?.segmentId ?? null,
        archiveThroughPosition: value.archiveThroughPosition, payloadJson: canonicalJson(value.payload),
        encodedBytes: value.encodedBytes, createdAt: value.createdAt,
      }).run());
      return;
    }
    case DurableCollections.conversationPublicSegments: {
      const value = decodePublicSegment(record.value);
      await resolved(database.insert(spConversationPublicSegments).values({
        segmentId: value.segmentId, conversationId: value.conversationId,
        previousSegmentId: value.previous?.segmentId ?? null, firstPosition: value.firstPosition,
        lastPosition: value.lastPosition, rootsJson: canonicalJson(value.roots), contentHash: value.contentHash,
        encodedBytes: value.encodedBytes, createdAt: value.createdAt,
      }).run());
      return;
    }
    case DurableCollections.conversationTerminalSegments: {
      const value = decodeTerminalSegment(record.value);
      await resolved(database.insert(spConversationTerminalSegments).values({
        segmentId: value.segmentId, conversationId: value.conversationId, logicalTurnId: value.logicalTurnId,
        executionId: value.executionId, publicationKey: value.publicationKey,
        previousSegmentId: value.previous?.segmentId ?? null, firstPosition: value.firstPosition,
        lastPosition: value.lastPosition, entriesJson: canonicalJson(value.entries), contentHash: value.contentHash,
        createdAt: value.createdAt,
      }).run());
      return;
    }
    case DurableCollections.executionJournalSegments:
    case DurableCollections.executionReplaySegments: {
      // Mutation values come from the mandatory semantic codec, which already
      // checked hashes, ranges, byte counts, and entry bounds. The SQLite
      // binding only needs the canonical envelope fields for insertion.
      const value = decodePrivateSegment(record.value);
      const table = record.collection === DurableCollections.executionJournalSegments ? spExecutionJournalSegments : spExecutionReplaySegments;
      await resolved(database.insert(table).values({
        segmentId: value.segmentId, executionId: value.executionId, taskId: value.taskId,
        previousSegmentId: value.previous?.segmentId ?? null, firstSequence: value.firstSequence,
        lastSequence: value.lastSequence, entriesJson: canonicalJson(value.entries), contentHash: value.contentHash,
        encodedBytes: value.encodedBytes, createdAt: value.createdAt,
      }).run());
      return;
    }
    case DurableCollections.executionObjects: {
      const envelope = decodeJsonValue(record.value, "execution object mutation") as Readonly<
        Record<string, Json>
      >;
      const value =
        envelope["bodyKind"] === "json"
          ? ({
              objectId: envelope["objectId"],
              lifetimeScope: envelope["lifetimeScope"],
              scopeOwnerId: envelope["scopeOwnerId"],
              objectKind: envelope["objectKind"],
              contentHash: envelope["contentHash"],
              byteLength: envelope["byteLength"],
              body: envelope["body"],
              createdAt: envelope["createdAt"],
            } as StoredExecutionObject)
          : decodeExecutionObject(record.value);
      const binary = value.body instanceof Uint8Array;
      await resolved(database.insert(spExecutionObjects).values({
        objectId: value.objectId, lifetimeScope: value.lifetimeScope, scopeOwnerId: value.scopeOwnerId,
        objectKind: value.objectKind, contentHash: value.contentHash, byteLength: value.byteLength,
        jsonBody: binary ? null : canonicalJson(value.body), blobBody: binary ? value.body : null,
        createdAt: value.createdAt,
      }).run());
    }
  }
}

async function replaceAuthority(database: Database, next: StoredAuthorityRecord, current: StoredAuthorityRecord | null): Promise<void> {
  if (next.collection === DurableCollections.conversationHeads) {
    const value = decodeConversationHead(next.value);
    const row = {
      revision: value.revision, ownerEpoch: value.ownerEpoch,
      ownerRouteJson: value.ownerRoute === null ? null : canonicalJson(value.ownerRoute), state: value.state,
      checkpointId: value.checkpoint?.checkpointId ?? null,
      terminalSegmentId: value.terminalHistory?.segmentId ?? null,
      activeLogicalTurnId: value.activeLogicalTurnId, activeExecutionId: value.activeExecutionId,
      latestCompletedExecutionId: value.latestCompletedExecutionId,
      activeSegmentJson: value.activeSegment === null ? null : canonicalJson(value.activeSegment),
      activeCommandJson: value.activeCommand === null ? null : canonicalJson(value.activeCommand),
      deletedAt: value.deletedAt, updatedAt: value.updatedAt,
    };
    if (current === null) {
      await resolved(
        database
          .insert(spConversationHeads)
          .values({ conversationId: value.conversationId, ...row })
          .run(),
      );
    } else {
      await resolved(
        database
          .update(spConversationHeads)
          .set(row)
          .where(eq(spConversationHeads.conversationId, value.conversationId))
          .run(),
      );
    }
    return;
  }
  const value = decodeExecutionControl(next.value);
  const row = {
    controlRevision: value.controlRevision, ownerFence: value.ownerFence, status: value.status,
    rootTaskId: value.rootTaskId, stopGeneration: value.stopGeneration,
    requestedDisposition: value.requestedDisposition, controlJson: canonicalJson(value.control), updatedAt: value.updatedAt,
  };
  if (current === null) {
    await resolved(
      database
        .insert(spExecutionControl)
        .values({ executionId: value.executionId, ...row })
        .run(),
    );
  } else {
    await resolved(
      database
        .update(spExecutionControl)
        .set(row)
        .where(eq(spExecutionControl.executionId, value.executionId))
        .run(),
    );
  }
}

function privateRecord(
  collection:
    | typeof DurableCollections.executionJournalSegments
    | typeof DurableCollections.executionReplaySegments,
  row: PrivateRow,
): StoredImmutableRecord {
  return immutableRecord(
    collection,
    executionKeys.segment(row.segmentId),
    row.contentHash,
    privateEnvelopeFromRow(row),
  );
}

async function prefetchPrivateCandidates(
  database: Database,
  ensures: DurableMutation["ensures"],
): Promise<ReadonlyMap<string, readonly StoredImmutableRecord[]>> {
  const result = new Map<string, readonly StoredImmutableRecord[]>();
  for (const collection of [
    DurableCollections.executionJournalSegments,
    DurableCollections.executionReplaySegments,
  ] as const) {
    const selected = ensures.filter((ensure) => ensure.collection === collection);
    if (selected.length < 4) {
      continue;
    }
    const ranges = selected.map((ensure) =>
      requireKey(ensure.alternateKeys?.[0] ?? "", [4]),
    );
    const segmentIds = selected.map((ensure) => requireKey(ensure.key, [1])[0]!);
    const executionIds = [...new Set(ranges.map((range) => range[0]!))];
    const taskIds = [...new Set(ranges.map((range) => range[1]!))];
    const firstSequences = [...new Set(ranges.map((range) => range[2]!))];
    const lastSequences = [...new Set(ranges.map((range) => range[3]!))];
    const table =
      collection === DurableCollections.executionJournalSegments
        ? spExecutionJournalSegments
        : spExecutionReplaySegments;
    const rows = await resolved(
      database
        .select()
        .from(table)
        .where(
          or(
            inArray(table.segmentId, segmentIds),
            and(
              inArray(table.executionId, executionIds),
              inArray(table.taskId, taskIds),
              inArray(table.firstSequence, firstSequences),
              inArray(table.lastSequence, lastSequences),
            ),
          ),
        )
        .all() as PrivateRow[] | Promise<PrivateRow[]>,
    );
    const byId = new Map(rows.map((row) => [row.segmentId, row]));
    const byRange = new Map(
      rows.map((row) => [
        executionKeys.taskRange(
          row.executionId,
          row.taskId,
          row.firstSequence,
          row.lastSequence,
        ),
        row,
      ]),
    );
    for (const ensure of selected) {
      const [segmentId] = requireKey(ensure.key, [1]);
      const matches = new Map<string, PrivateRow>();
      const idMatch = byId.get(segmentId!);
      const rangeMatch = byRange.get(ensure.alternateKeys![0]!);
      if (idMatch) {
        matches.set(idMatch.segmentId, idMatch);
      }
      if (rangeMatch) {
        matches.set(rangeMatch.segmentId, rangeMatch);
      }
      result.set(
        ensure.name,
        [...matches.values()].map((row) => privateRecord(collection, row)),
      );
    }
  }
  return result;
}

async function insertPrivateBatch(
  database: Database,
  collection:
    | typeof DurableCollections.executionJournalSegments
    | typeof DurableCollections.executionReplaySegments,
  ensures: readonly DurableMutation["ensures"][number][],
): Promise<void> {
  if (ensures.length === 0) {
    return;
  }
  const table =
    collection === DurableCollections.executionJournalSegments
      ? spExecutionJournalSegments
      : spExecutionReplaySegments;
  const values = ensures.map((ensure) => {
    const value = decodePrivateSegment(ensure.value);
    return {
      segmentId: value.segmentId,
      executionId: value.executionId,
      taskId: value.taskId,
      previousSegmentId: value.previous?.segmentId ?? null,
      firstSequence: value.firstSequence,
      lastSequence: value.lastSequence,
      entriesJson: canonicalJson(value.entries),
      contentHash: value.contentHash,
      encodedBytes: value.encodedBytes,
      createdAt: value.createdAt,
    };
  });
  await resolved(database.insert(table).values(values).run());
}

async function readEnsureCandidates(
  database: Database,
  ensure: DurableMutation["ensures"][number],
): Promise<readonly StoredImmutableRecord[]> {
  if (
    (ensure.collection === DurableCollections.executionJournalSegments ||
      ensure.collection === DurableCollections.executionReplaySegments) &&
    ensure.alternateKeys?.length === 1
  ) {
    const [segmentId] = requireKey(ensure.key, [1]);
    const [executionId, taskId, firstSequence, lastSequence] = requireKey(
      ensure.alternateKeys[0]!,
      [4],
    );
    const table =
      ensure.collection === DurableCollections.executionJournalSegments
        ? spExecutionJournalSegments
        : spExecutionReplaySegments;
    const rows = await resolved(
      database
        .select()
        .from(table)
        .where(
          or(
            eq(table.segmentId, segmentId!),
            and(
              eq(table.executionId, executionId!),
              eq(table.taskId, taskId!),
              eq(table.firstSequence, firstSequence!),
              eq(table.lastSequence, lastSequence!),
            ),
          ),
        )
        .limit(2)
        .all() as PrivateRow[] | Promise<PrivateRow[]>,
    );
    const collection =
      ensure.collection === DurableCollections.executionJournalSegments
        ? DurableCollections.executionJournalSegments
        : DurableCollections.executionReplaySegments;
    return rows.map((row) => privateRecord(collection, row));
  }
  const candidates: StoredImmutableRecord[] = [];
  for (const key of [ensure.key, ...(ensure.alternateKeys ?? [])]) {
    const candidate = await readImmutableIn(database, ensure.collection, key);
    if (candidate && !candidates.some((existing) => existing.key === candidate.key)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function applyIn(database: Database, mutation: DurableMutation, faultInjection?: (point: string) => void): Promise<DurableMutationOutcome> {
  validateMutationStructure(mutation);
  if (mutation.claim) {
    const existing = await readImmutableIn(database, mutation.claim.collection, mutation.claim.key);
    if (existing) {
      return { status: "claim_exists", claim: mutation.claim.name, existing };
    }
  }
  let current: StoredAuthorityRecord | null = null;
  if (mutation.authority) {
    current = await readAuthorityIn(database, mutation.authority.collection, mutation.authority.key);
    const mismatch = authorityMismatch(mutation.authority, current);
    if (mismatch) {
      return {
        status: "authority_conflict",
        authority: mutation.authority.name,
        mismatch,
        current,
      };
    }
  }
  const resolvedRecords = new Map<string, StoredImmutableRecord>();
  const prefetchedPrivate = await prefetchPrivateCandidates(database, mutation.ensures);
  for (const ensure of mutation.ensures) {
    const candidates =
      prefetchedPrivate.get(ensure.name) ??
      (await readEnsureCandidates(database, ensure));
    if (candidates.length > 1) {
      return {
        status: "immutable_conflict",
        write: ensure.name,
        existing: candidates[1]!,
      };
    }
    const existing = candidates[0] ?? null;
    if (existing) {
      if (
        existing.fingerprint !== ensure.fingerprint ||
        (mutation.authority !== undefined && existing.key !== ensure.key)
      ) {
        return { status: "immutable_conflict", write: ensure.name, existing };
      }
      resolvedRecords.set(ensure.name, existing);
    }
  }
  if (mutation.claim) {
    await insertImmutable(database, mutation.claim);
    if (mutation.authority?.collection === DurableCollections.conversationHeads) {
      faultInjection?.("command-after-receipt");
    }
  }
  const missing = mutation.ensures.filter((ensure) => !resolvedRecords.has(ensure.name));
  for (const collection of [
    DurableCollections.executionJournalSegments,
    DurableCollections.executionReplaySegments,
  ] as const) {
    await insertPrivateBatch(
      database,
      collection,
      missing.filter((ensure) => ensure.collection === collection),
    );
  }
  for (const ensure of missing) {
    if (
      ensure.collection !== DurableCollections.executionJournalSegments &&
      ensure.collection !== DurableCollections.executionReplaySegments
    ) {
      await insertImmutable(database, ensure);
    }
    resolvedRecords.set(
      ensure.name,
      immutableRecord(
        ensure.collection,
        ensure.key,
        ensure.fingerprint,
        ensure.value,
      ),
    );
  }
  if (
    mutation.authority?.collection === DurableCollections.executionControls &&
    mutation.ensures.length > 0
  ) {
    faultInjection?.("execution-after-segment-insert");
  }
  let authority: StoredAuthorityRecord | null = null;
  if (mutation.authority) {
    authority = {
      collection: mutation.authority.collection, key: mutation.authority.key,
      revision: mutation.authority.next.revision, fence: mutation.authority.next.fence ?? current?.fence ?? null,
      value: mutation.authority.next.value,
    };
    await replaceAuthority(database, authority, current);
    if (
      mutation.authority.collection === DurableCollections.conversationHeads &&
      mutation.claim
    ) {
      faultInjection?.("command-before-commit");
    }
    if (mutation.authority.collection === DurableCollections.executionControls) {
      faultInjection?.("execution-before-commit");
    }
  }
  return { status: "committed", authority, ensured: Object.fromEntries(resolvedRecords) };
}

async function scanIn(database: Database, request: BoundedScan): Promise<StoredScanPage> {
  validateScan(request);
  const scope = decodeDurableKey(request.scope);
  let rows: Array<PublicRow | TerminalRow | PrivateRow>;
  if (request.index === DurableIndexes.conversationPosition) {
    const [conversationId] = scope;
    const table =
      request.collection === DurableCollections.conversationPublicSegments
        ? spConversationPublicSegments
        : spConversationTerminalSegments;
    const conditions: SQL[] = [eq(table.conversationId, conversationId!)];
    if (request.after !== null) {
      conditions.push(
        request.direction === "forward"
          ? gt(table.firstPosition, request.after)
          : lt(table.firstPosition, request.after),
      );
    }
    if (request.through !== undefined) {
      conditions.push(
        request.direction === "forward"
          ? lte(table.firstPosition, request.through)
          : gte(table.firstPosition, request.through),
      );
    }
    rows = await resolved(
      database
        .select()
        .from(table)
        .where(and(...conditions))
        .orderBy(
          request.direction === "forward"
            ? asc(table.firstPosition)
            : desc(table.firstPosition),
        )
        .limit(request.maxRecords + 1)
        .all() as
        | Array<PublicRow | TerminalRow>
        | Promise<Array<PublicRow | TerminalRow>>,
    );
  } else {
    const [executionId, taskId] = scope;
    const table =
      request.collection === DurableCollections.executionJournalSegments
        ? spExecutionJournalSegments
        : spExecutionReplaySegments;
    const conditions: SQL[] = [
      eq(table.executionId, executionId!),
      eq(table.taskId, taskId!),
    ];
    if (request.after !== null) {
      conditions.push(
        request.direction === "forward"
          ? gt(table.firstSequence, request.after)
          : lt(table.firstSequence, request.after),
      );
    }
    if (request.through !== undefined) {
      conditions.push(
        request.direction === "forward"
          ? lte(table.firstSequence, request.through)
          : gte(table.firstSequence, request.through),
      );
    }
    rows = await resolved(
      database
        .select()
        .from(table)
        .where(and(...conditions))
        .orderBy(
          request.direction === "forward"
            ? asc(table.firstSequence)
            : desc(table.firstSequence),
        )
        .limit(request.maxRecords + 1)
        .all() as PrivateRow[] | Promise<PrivateRow[]>,
    );
  }
  const after = request.after === null ? null : BigInt(request.after);
  const through = request.through === undefined ? null : BigInt(request.through);
  const records = [];
  let bytes = 0;
  let more = false;
  for (const row of rows) {
    const position = "firstPosition" in row ? row.firstPosition : row.firstSequence;
    const numeric = BigInt(position);
    if (
      after !== null &&
      (request.direction === "forward" ? numeric <= after : numeric >= after)
    ) {
      continue;
    }
    if (
      through !== null &&
      (request.direction === "forward" ? numeric > through : numeric < through)
    ) {
      continue;
    }
    const record =
      request.collection === DurableCollections.conversationPublicSegments
        ? immutableRecord(request.collection, conversationKeys.publicSegment(row.segmentId), row.contentHash, encodePublicSegment(publicFromRow(row as PublicRow)))
        : request.collection === DurableCollections.conversationTerminalSegments
          ? immutableRecord(request.collection, conversationKeys.terminalSegment(row.segmentId), row.contentHash, encodeTerminalSegment(terminalFromRow(row as TerminalRow)))
          : immutableRecord(
              request.collection,
              executionKeys.segment(row.segmentId),
              row.contentHash,
              privateEnvelopeFromRow(row as PrivateRow),
            );
    if (records.length >= request.maxRecords || bytes + record.value.byteLength > request.maxStoredBytes) { more = true; break; }
    records.push({ ...record, position, storedBytes: record.value.byteLength });
    bytes += record.value.byteLength;
  }
  return { records, nextCursor: more && records.length > 0 ? records.at(-1)!.position : null };
}

export function createSqliteDurableKernel<TResultKind extends SQLiteResultKind, TRunResult>(options: {
  database: SweatpantsSqliteDatabase<TResultKind, TRunResult>;
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<TResultKind, TRunResult>>;
  faultInjection?: (point: string) => void;
}): DurableKernel {
  const database = options.database as Database;
  const transactions = options.transactions as SqliteImmediateTransactions<Database>;
  return {
    *readAuthority(collection, key): Operation<StoredAuthorityRecord | null> {
      return yield* call(() => readAuthorityIn(database, collection, key));
    },
    *readImmutable(collection, key): Operation<StoredImmutableRecord | null> {
      return yield* call(() => readImmutableIn(database, collection, key));
    },
    *scan(request): Operation<StoredScanPage> {
      return yield* call(() => scanIn(database, request));
    },
    *waitForChange(request): Operation<void> {
      const deadline = Date.now() + Math.max(0, request.timeoutMs);
      while (Date.now() < deadline) {
        const current = yield* call(() => readAuthorityIn(database, request.collection, request.key));
        if (current && BigInt(current.revision) > BigInt(request.afterRevision)) {
          return;
        }
        yield* sleep(Math.min(10, deadline - Date.now()));
      }
    },
    *apply(mutation): Operation<DurableMutationOutcome> {
      validateMutationStructure(mutation);
      return yield* transactions.immediate((transaction) => applyIn(transaction, mutation, options.faultInjection));
    },
  };
}
