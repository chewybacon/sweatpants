import {
  DurableCollections,
  DurableIndexes,
  authorityMismatch,
  decodeDurableKey,
  decodeJsonValue,
  validateMutationStructure,
  validateScan,
  DurableKernelError,
  type AuthorityCollectionId,
  type BoundedScan,
  type DurableKernel,
  type DurableMutation,
  type DurableMutationOutcome,
  type ImmutableCollectionId,
  type StoredAuthorityRecord,
  type StoredImmutableRecord,
  type StoredScanPage,
  type TransactionRunner,
} from "@sweatpants/durable-storage-kernel";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { canonicalJson, canonicalSnapshot, parseJsonText, type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import { call, sleep } from "effection";
import {
  conversationKeys,
  decodeArchivedPublicRootIndex,
  decodeCheckpoint,
  decodeCommandReceipt,
  decodeConversationHead,
  decodePublicSegment,
  decodeTerminalSegment,
  encodeArchivedPublicRootIndex,
  encodeCheckpoint,
  encodeCommandReceipt,
  encodeConversationHead,
  encodePublicSegment,
  encodeTerminalSegment,
} from "@sweatpants/history-store/persistence";
import type {
  ArchivedPublicRootIndex,
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
import type { ExecutionControl, StoredExecutionObject } from "@sweatpants/journal-authority/store";
import {
  spConversationCheckpoints,
  spConversationCommandReceipts,
  spConversationHeads,
  spConversationPublicRootIndex,
  spConversationPublicSegments,
  spConversationTerminalSegments,
  spExecutionControl,
  spExecutionJournalSegments,
  spExecutionObjects,
  spExecutionReplaySegments,
  type ConversationHeadRow,
  type CheckpointRow,
  type CommandReceiptRow,
  type ExecutionControlRow,
  type ExecutionObjectRow,
  type JournalSegmentRow,
  type PostgresSchema,
  type PublicRootIndexRow,
  type PublicSegmentRow,
  type TerminalSegmentRow,
} from "./schema.ts";

/**
 * Any drizzle pg executor over the authority schema. Covers node-postgres,
 * postgres.js-style async drivers, and embedded runtimes behind the same
 * query interface.
 */
export type SweatpantsPostgresDatabase = PgDatabase<PgQueryResultHKT, PostgresSchema>;

type Database = SweatpantsPostgresDatabase;
type HeadRow = ConversationHeadRow;
type ReceiptRow = CommandReceiptRow;
type PublicRow = PublicSegmentRow;
type TerminalRow = TerminalSegmentRow;
type ControlRow = ExecutionControlRow;
type PrivateRow = JournalSegmentRow;
type ObjectRow = ExecutionObjectRow;

function invalid(message: string): never {
  throw new DurableKernelError("durable_kernel_persisted_data_invalid", message);
}

function numberValue(value: number | string | bigint, field: string): number {
  const result =
    typeof value === "bigint" ? Number(value) : typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(result) && result >= 0
    ? result
    : invalid(`${field} is outside the safe integer range`);
}

function requireKey(key: string, lengths: readonly number[]): readonly string[] {
  const parts = decodeDurableKey(key);
  if (!lengths.includes(parts.length)) {
    throw new DurableKernelError(
      "durable_kernel_persisted_data_invalid",
      `Unexpected durable key shape ${key}`,
    );
  }
  return parts;
}

function priorPosition(first: string): string {
  return (BigInt(first) > 0n ? BigInt(first) - 1n : 0n).toString(10);
}

function immutableRecord(
  collection: ImmutableCollectionId,
  key: string,
  fingerprint: string,
  value: Uint8Array,
): StoredImmutableRecord {
  return { collection, key, fingerprint, value };
}

/**
 * Serializes mutations against the same authority key. The advisory
 * transaction lock covers head/control creation races that row locks cannot
 * (the row may not exist yet) and stays held until commit or rollback.
 */
async function lockAuthority(database: Database, mutation: DurableMutation): Promise<void> {
  if (!mutation.authority) {
    return;
  }
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`sp:${mutation.authority.collection}:${mutation.authority.key}`}, 0))`,
  );
}

async function selectHead(database: Database, conversationId: string): Promise<HeadRow | null> {
  const rows = await database
    .select()
    .from(spConversationHeads)
    .where(eq(spConversationHeads.conversationId, conversationId))
    .limit(1);
  return rows[0] ?? null;
}

async function selectControl(database: Database, executionId: string): Promise<ControlRow | null> {
  const rows = await database
    .select()
    .from(spExecutionControl)
    .where(eq(spExecutionControl.executionId, executionId))
    .limit(1);
  return rows[0] ?? null;
}

async function selectTerminal(database: Database, segmentId: string): Promise<TerminalRow | null> {
  const rows = await database
    .select()
    .from(spConversationTerminalSegments)
    .where(eq(spConversationTerminalSegments.segmentId, segmentId))
    .limit(1);
  return rows[0] ?? null;
}

async function headFromRow(database: Database, row: HeadRow): Promise<ConversationHead> {
  const terminal =
    row.terminalSegmentId === null
      ? undefined
      : await selectTerminal(database, row.terminalSegmentId);
  if (row.terminalSegmentId !== null && terminal === undefined) {
    return invalid(`Head ${row.conversationId} points to missing terminal segment`);
  }
  return decodeConversationHead(
    encodeConversationHead({
      conversationId: row.conversationId,
      revision: row.revision,
      ownerEpoch: row.ownerEpoch,
      ownerRoute:
        row.ownerRouteJson === null ? null : parseJsonText(row.ownerRouteJson, "owner_route_json"),
      state: row.state as ConversationHead["state"],
      checkpoint: row.checkpointId === null ? null : { checkpointId: row.checkpointId },
      terminalHistory:
        row.terminalSegmentId === null
          ? null
          : { segmentId: row.terminalSegmentId, lastPosition: terminal!.lastPosition },
      activeLogicalTurnId: row.activeLogicalTurnId,
      activeExecutionId: row.activeExecutionId,
      latestCompletedExecutionId: row.latestCompletedExecutionId,
      activeSegment:
        row.activeSegmentJson === null
          ? null
          : parseJsonText(row.activeSegmentJson, "active_segment_json"),
      activeCommand:
        row.activeCommandJson === null
          ? null
          : parseJsonText(row.activeCommandJson, "active_command_json"),
      deletedAt: row.deletedAt === null ? null : numberValue(row.deletedAt, "deleted_at"),
      updatedAt: numberValue(row.updatedAt, "updated_at"),
    }),
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
    return {
      collection,
      key,
      revision: head.revision,
      fence: head.ownerEpoch,
      value: encodeConversationHead(head),
    };
  }
  const row = await selectControl(database, id!);
  if (!row) {
    return null;
  }
  const control = controlFromRow(row);
  return {
    collection,
    key,
    revision: control.controlRevision,
    fence: control.ownerFence,
    value: encodeExecutionControl(control),
  };
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
    lineageId: row.lineageId,
    archiveHead: row.archiveHeadSegmentId === null ? null : { segmentId: row.archiveHeadSegmentId },
    archiveFrontierOrdinal: row.archiveFrontierOrdinal,
    nextPublicPosition: row.nextPublicPosition,
    payload: parseJsonText(row.payloadJson, "payload_json"),
    encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}

function publicFromRow(row: PublicRow): StoredPublicArchiveSegment {
  const value: StoredPublicArchiveSegment = {
    segmentId: row.segmentId,
    conversationId: row.conversationId,
    previous: row.previousSegmentId === null ? null : { segmentId: row.previousSegmentId },
    minPosition: row.minPosition,
    maxPosition: row.maxPosition,
    roots: parseJsonText(row.rootsJson, "roots_json") as readonly Json[],
    contentHash: row.contentHash,
    encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
    createdAt: numberValue(row.createdAt, "created_at"),
  };
  return value;
}

function publicRootIndexFromRow(row: PublicRootIndexRow): ArchivedPublicRootIndex {
  return {
    conversationId: row.conversationId,
    position: row.position,
    rootId: row.rootId,
    segmentId: row.segmentId,
    segmentRootIndex: numberValue(row.segmentRootIndex, "segment_root_index"),
    archiveOrdinal: row.archiveOrdinal,
    contentHash: row.contentHash,
    encodedBytes: numberValue(row.encodedBytes, "encoded_bytes"),
  };
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

async function readImmutableIn(
  database: Database,
  collection: ImmutableCollectionId,
  key: string,
): Promise<StoredImmutableRecord | null> {
  const parts = decodeDurableKey(key);
  switch (collection) {
    case DurableCollections.conversationCommandReceipts: {
      const [conversationId, commandId] = requireKey(key, [2]);
      const rows = await database
        .select()
        .from(spConversationCommandReceipts)
        .where(
          and(
            eq(spConversationCommandReceipts.conversationId, conversationId!),
            eq(spConversationCommandReceipts.commandId, commandId!),
          ),
        )
        .limit(1);
      if (!rows[0]) {
        return null;
      }
      const value = receiptFromRow(rows[0]);
      return immutableRecord(
        collection,
        conversationKeys.receipt(value.conversationId, value.commandId),
        value.commandDigest,
        encodeCommandReceipt(value),
      );
    }
    case DurableCollections.conversationCheckpoints: {
      const rows = await database
        .select()
        .from(spConversationCheckpoints)
        .where(
          parts.length === 1
            ? eq(spConversationCheckpoints.checkpointId, parts[0]!)
            : and(
                eq(spConversationCheckpoints.conversationId, parts[0]!),
                eq(spConversationCheckpoints.causeKey, parts[1]!),
              ),
        )
        .limit(1);
      if (!rows[0]) {
        return null;
      }
      const value = checkpointFromRow(rows[0]);
      return immutableRecord(
        collection,
        conversationKeys.checkpoint(value.checkpointId),
        value.contentHash,
        encodeCheckpoint(value),
      );
    }
    case DurableCollections.conversationPublicSegments: {
      const rows = await database
        .select()
        .from(spConversationPublicSegments)
        .where(
          parts.length === 1
            ? eq(spConversationPublicSegments.segmentId, parts[0]!)
            : and(
                eq(spConversationPublicSegments.conversationId, parts[0]!),
                eq(spConversationPublicSegments.minPosition, parts[1]!),
                eq(spConversationPublicSegments.segmentId, parts[2]!),
              ),
        )
        .limit(1);
      if (!rows[0]) {
        return null;
      }
      const value = publicFromRow(rows[0]);
      return immutableRecord(
        collection,
        conversationKeys.publicSegment(value.segmentId),
        value.contentHash,
        encodePublicSegment(value),
      );
    }
    case DurableCollections.conversationPublicRootIndex: {
      const where =
        parts.length === 2
          ? and(
              eq(spConversationPublicRootIndex.conversationId, parts[0]!),
              eq(spConversationPublicRootIndex.position, parts[1]!),
            )
          : and(
              eq(spConversationPublicRootIndex.conversationId, parts[0]!),
              eq(spConversationPublicRootIndex.rootId, parts[2]!),
            );
      const rows = await database
        .select()
        .from(spConversationPublicRootIndex)
        .where(where)
        .limit(1);
      if (!rows[0]) {
        return null;
      }
      const entry = publicRootIndexFromRow(rows[0]);
      return immutableRecord(
        collection,
        conversationKeys.publicRootIndex(entry.conversationId, entry.position),
        canonicalSnapshot(entry).sha,
        encodeArchivedPublicRootIndex(entry),
      );
    }
    case DurableCollections.conversationTerminalSegments: {
      const where =
        parts.length === 1
          ? eq(spConversationTerminalSegments.segmentId, parts[0]!)
          : parts.length === 2
            ? and(
                eq(spConversationTerminalSegments.conversationId, parts[0]!),
                eq(spConversationTerminalSegments.publicationKey, parts[1]!),
              )
            : and(
                eq(spConversationTerminalSegments.conversationId, parts[0]!),
                eq(spConversationTerminalSegments.firstPosition, parts[1]!),
                eq(spConversationTerminalSegments.segmentId, parts[2]!),
              );
      const rows = await database
        .select()
        .from(spConversationTerminalSegments)
        .where(where)
        .limit(1);
      if (!rows[0]) {
        return null;
      }
      const value = terminalFromRow(rows[0]);
      return immutableRecord(
        collection,
        conversationKeys.terminalSegment(value.segmentId),
        value.contentHash,
        encodeTerminalSegment(value),
      );
    }
    case DurableCollections.executionJournalSegments:
    case DurableCollections.executionReplaySegments: {
      const table =
        collection === DurableCollections.executionJournalSegments
          ? spExecutionJournalSegments
          : spExecutionReplaySegments;
      const where =
        parts.length === 1
          ? eq(table.segmentId, parts[0]!)
          : and(
              eq(table.executionId, parts[0]!),
              eq(table.taskId, parts[1]!),
              eq(table.firstSequence, parts[2]!),
              eq(table.lastSequence, parts[3]!),
            );
      const rows = await database.select().from(table).where(where).limit(1);
      if (!rows[0]) {
        return null;
      }
      return immutableRecord(
        collection,
        executionKeys.segment(rows[0].segmentId),
        rows[0].contentHash,
        privateEnvelopeFromRow(rows[0]),
      );
    }
    case DurableCollections.executionObjects: {
      const [objectId] = requireKey(key, [1]);
      const rows = await database
        .select()
        .from(spExecutionObjects)
        .where(eq(spExecutionObjects.objectId, objectId!))
        .limit(1);
      if (!rows[0]) {
        return null;
      }
      const value = objectFromRow(rows[0]);
      return immutableRecord(
        collection,
        executionKeys.object(value.objectId),
        value.contentHash,
        encodeExecutionObjectEnvelope(value),
      );
    }
  }
}

/**
 * Inserts an immutable record. Postgres uniqueness constraints back the
 * kernel's idempotency: `ON CONFLICT DO NOTHING` plus a re-read replaces the
 * SQLite binding's serialized-writer guarantee for claim-only mutations.
 */
async function insertImmutable(
  database: Database,
  record: { collection: ImmutableCollectionId; key: string; value: Uint8Array },
): Promise<boolean> {
  switch (record.collection) {
    case DurableCollections.conversationCommandReceipts: {
      const value = decodeCommandReceipt(record.value);
      const inserted = await database
        .insert(spConversationCommandReceipts)
        .values({
          conversationId: value.conversationId,
          commandId: value.commandId,
          commandDigest: value.commandDigest,
          participantId: value.participantId,
          acceptedAt: value.acceptedAt,
          retainUntil: value.retainUntil,
          admittedRevision: value.admittedRevision,
          resultingRevision: value.resultingRevision,
          logicalTurnId: value.logicalTurnId ?? null,
          executionId: value.executionId ?? null,
        })
        .onConflictDoNothing()
        .returning({ commandId: spConversationCommandReceipts.commandId });
      return inserted.length > 0;
    }
    case DurableCollections.conversationCheckpoints: {
      const value = decodeCheckpoint(record.value);
      const inserted = await database
        .insert(spConversationCheckpoints)
        .values({
          checkpointId: value.checkpointId,
          conversationId: value.conversationId,
          causeKey: value.causeKey,
          causeJson: canonicalJson(value.cause),
          contentHash: value.contentHash,
          lineageId: value.lineageId,
          archiveHeadSegmentId: value.archiveHead?.segmentId ?? null,
          archiveFrontierOrdinal: value.archiveFrontierOrdinal,
          nextPublicPosition: value.nextPublicPosition,
          payloadJson: canonicalJson(value.payload),
          encodedBytes: value.encodedBytes,
          createdAt: value.createdAt,
        })
        .onConflictDoNothing()
        .returning({ checkpointId: spConversationCheckpoints.checkpointId });
      return inserted.length > 0;
    }
    case DurableCollections.conversationPublicSegments: {
      const value = decodePublicSegment(record.value);
      const inserted = await database
        .insert(spConversationPublicSegments)
        .values({
          segmentId: value.segmentId,
          conversationId: value.conversationId,
          previousSegmentId: value.previous?.segmentId ?? null,
          minPosition: value.minPosition,
          maxPosition: value.maxPosition,
          rootsJson: canonicalJson(value.roots),
          contentHash: value.contentHash,
          encodedBytes: value.encodedBytes,
          createdAt: value.createdAt,
        })
        .onConflictDoNothing()
        .returning({ segmentId: spConversationPublicSegments.segmentId });
      return inserted.length > 0;
    }
    case DurableCollections.conversationPublicRootIndex: {
      const value = decodeArchivedPublicRootIndex(record.value);
      const inserted = await database
        .insert(spConversationPublicRootIndex)
        .values({
          conversationId: value.conversationId,
          position: value.position,
          rootId: value.rootId,
          segmentId: value.segmentId,
          segmentRootIndex: value.segmentRootIndex,
          archiveOrdinal: value.archiveOrdinal,
          contentHash: value.contentHash,
          encodedBytes: value.encodedBytes,
        })
        .onConflictDoNothing()
        .returning({ position: spConversationPublicRootIndex.position });
      return inserted.length > 0;
    }
    case DurableCollections.conversationTerminalSegments: {
      const value = decodeTerminalSegment(record.value);
      const inserted = await database
        .insert(spConversationTerminalSegments)
        .values({
          segmentId: value.segmentId,
          conversationId: value.conversationId,
          logicalTurnId: value.logicalTurnId,
          executionId: value.executionId,
          publicationKey: value.publicationKey,
          previousSegmentId: value.previous?.segmentId ?? null,
          firstPosition: value.firstPosition,
          lastPosition: value.lastPosition,
          entriesJson: canonicalJson(value.entries),
          contentHash: value.contentHash,
          createdAt: value.createdAt,
        })
        .onConflictDoNothing()
        .returning({ segmentId: spConversationTerminalSegments.segmentId });
      return inserted.length > 0;
    }
    case DurableCollections.executionJournalSegments:
    case DurableCollections.executionReplaySegments: {
      const value = decodePrivateSegment(record.value);
      const table =
        record.collection === DurableCollections.executionJournalSegments
          ? spExecutionJournalSegments
          : spExecutionReplaySegments;
      const inserted = await database
        .insert(table)
        .values({
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
        })
        .onConflictDoNothing()
        .returning({ segmentId: table.segmentId });
      return inserted.length > 0;
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
      const inserted = await database
        .insert(spExecutionObjects)
        .values({
          objectId: value.objectId,
          lifetimeScope: value.lifetimeScope,
          scopeOwnerId: value.scopeOwnerId,
          objectKind: value.objectKind,
          contentHash: value.contentHash,
          byteLength: value.byteLength,
          jsonBody: binary ? null : canonicalJson(value.body),
          blobBody: binary ? value.body : null,
          createdAt: value.createdAt,
        })
        .onConflictDoNothing()
        .returning({ objectId: spExecutionObjects.objectId });
      return inserted.length > 0;
    }
  }
}

async function replaceAuthority(
  database: Database,
  next: StoredAuthorityRecord,
  current: StoredAuthorityRecord | null,
): Promise<void> {
  if (next.collection === DurableCollections.conversationHeads) {
    const value = decodeConversationHead(next.value);
    const row = {
      revision: value.revision,
      ownerEpoch: value.ownerEpoch,
      ownerRouteJson: value.ownerRoute === null ? null : canonicalJson(value.ownerRoute),
      state: value.state,
      checkpointId: value.checkpoint?.checkpointId ?? null,
      terminalSegmentId: value.terminalHistory?.segmentId ?? null,
      activeLogicalTurnId: value.activeLogicalTurnId,
      activeExecutionId: value.activeExecutionId,
      latestCompletedExecutionId: value.latestCompletedExecutionId,
      activeSegmentJson: value.activeSegment === null ? null : canonicalJson(value.activeSegment),
      activeCommandJson: value.activeCommand === null ? null : canonicalJson(value.activeCommand),
      deletedAt: value.deletedAt,
      updatedAt: value.updatedAt,
    };
    if (current === null) {
      await database
        .insert(spConversationHeads)
        .values({ conversationId: value.conversationId, ...row });
    } else {
      await database
        .update(spConversationHeads)
        .set(row)
        .where(eq(spConversationHeads.conversationId, value.conversationId));
    }
    return;
  }
  const value = decodeExecutionControl(next.value);
  const row = {
    controlRevision: value.controlRevision,
    ownerFence: value.ownerFence,
    status: value.status,
    rootTaskId: value.rootTaskId,
    stopGeneration: value.stopGeneration,
    requestedDisposition: value.requestedDisposition,
    controlJson: canonicalJson(value.control),
    updatedAt: value.updatedAt,
  };
  if (current === null) {
    await database.insert(spExecutionControl).values({ executionId: value.executionId, ...row });
  } else {
    await database
      .update(spExecutionControl)
      .set(row)
      .where(eq(spExecutionControl.executionId, value.executionId));
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
    const ranges = selected.map((ensure) => requireKey(ensure.alternateKeys?.[0] ?? "", [4]));
    const segmentIds = selected.map((ensure) => requireKey(ensure.key, [1])[0]!);
    const executionIds = [...new Set(ranges.map((range) => range[0]!))];
    const taskIds = [...new Set(ranges.map((range) => range[1]!))];
    const firstSequences = [...new Set(ranges.map((range) => range[2]!))];
    const lastSequences = [...new Set(ranges.map((range) => range[3]!))];
    const table =
      collection === DurableCollections.executionJournalSegments
        ? spExecutionJournalSegments
        : spExecutionReplaySegments;
    const rows = await database
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
      );
    const byId = new Map(rows.map((row) => [row.segmentId, row]));
    const byRange = new Map(
      rows.map((row) => [
        executionKeys.taskRange(row.executionId, row.taskId, row.firstSequence, row.lastSequence),
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
  await database.insert(table).values(values).onConflictDoNothing();
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
    const rows = await database
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
      .limit(2);
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

async function applyIn(
  database: Database,
  mutation: DurableMutation,
  faultInjection?: (point: string) => void,
): Promise<DurableMutationOutcome> {
  validateMutationStructure(mutation);
  await lockAuthority(database, mutation);
  if (mutation.claim) {
    const existing = await readImmutableIn(database, mutation.claim.collection, mutation.claim.key);
    if (existing) {
      return { status: "claim_exists", claim: mutation.claim.name, existing };
    }
  }
  let current: StoredAuthorityRecord | null = null;
  if (mutation.authority) {
    current = await readAuthorityIn(
      database,
      mutation.authority.collection,
      mutation.authority.key,
    );
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
      prefetchedPrivate.get(ensure.name) ?? (await readEnsureCandidates(database, ensure));
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
    const inserted = await insertImmutable(database, mutation.claim);
    if (!inserted) {
      // A concurrent claim-only mutation won the uniqueness race.
      const existing = await readImmutableIn(
        database,
        mutation.claim.collection,
        mutation.claim.key,
      );
      if (existing) {
        return { status: "claim_exists", claim: mutation.claim.name, existing };
      }
      return invalid(`Claim ${mutation.claim.name} vanished after a lost insert race`);
    }
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
      immutableRecord(ensure.collection, ensure.key, ensure.fingerprint, ensure.value),
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
      collection: mutation.authority.collection,
      key: mutation.authority.key,
      revision: mutation.authority.next.revision,
      fence: mutation.authority.next.fence ?? current?.fence ?? null,
      value: mutation.authority.next.value,
    };
    await replaceAuthority(database, authority, current);
    if (mutation.authority.collection === DurableCollections.conversationHeads && mutation.claim) {
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
  let rows: Array<PublicRow | PublicRootIndexRow | TerminalRow | PrivateRow>;
  if (
    request.index === DurableIndexes.conversationPosition &&
    request.collection === DurableCollections.conversationPublicRootIndex
  ) {
    const [conversationId] = scope;
    const conditions: SQL[] = [eq(spConversationPublicRootIndex.conversationId, conversationId!)];
    if (request.after !== null) {
      conditions.push(
        request.direction === "forward"
          ? gt(spConversationPublicRootIndex.position, request.after)
          : lt(spConversationPublicRootIndex.position, request.after),
      );
    }
    if (request.through !== undefined) {
      conditions.push(
        request.direction === "forward"
          ? lte(spConversationPublicRootIndex.position, request.through)
          : gte(spConversationPublicRootIndex.position, request.through),
      );
    }
    rows = await database
      .select()
      .from(spConversationPublicRootIndex)
      .where(and(...conditions))
      .orderBy(
        request.direction === "forward"
          ? asc(spConversationPublicRootIndex.position)
          : desc(spConversationPublicRootIndex.position),
      )
      .limit(request.maxRecords + 1);
  } else if (
    request.index === DurableIndexes.conversationPosition &&
    request.collection === DurableCollections.conversationPublicSegments
  ) {
    const [conversationId] = scope;
    const conditions: SQL[] = [eq(spConversationPublicSegments.conversationId, conversationId!)];
    if (request.after !== null) {
      conditions.push(
        request.direction === "forward"
          ? gt(spConversationPublicSegments.minPosition, request.after)
          : lt(spConversationPublicSegments.minPosition, request.after),
      );
    }
    if (request.through !== undefined) {
      conditions.push(
        request.direction === "forward"
          ? lte(spConversationPublicSegments.minPosition, request.through)
          : gte(spConversationPublicSegments.minPosition, request.through),
      );
    }
    rows = await database
      .select()
      .from(spConversationPublicSegments)
      .where(and(...conditions))
      .orderBy(
        request.direction === "forward"
          ? asc(spConversationPublicSegments.minPosition)
          : desc(spConversationPublicSegments.minPosition),
      )
      .limit(request.maxRecords + 1);
  } else if (request.index === DurableIndexes.conversationPosition) {
    const [conversationId] = scope;
    const conditions: SQL[] = [eq(spConversationTerminalSegments.conversationId, conversationId!)];
    if (request.after !== null) {
      conditions.push(
        request.direction === "forward"
          ? gt(spConversationTerminalSegments.firstPosition, request.after)
          : lt(spConversationTerminalSegments.firstPosition, request.after),
      );
    }
    if (request.through !== undefined) {
      conditions.push(
        request.direction === "forward"
          ? lte(spConversationTerminalSegments.firstPosition, request.through)
          : gte(spConversationTerminalSegments.firstPosition, request.through),
      );
    }
    rows = await database
      .select()
      .from(spConversationTerminalSegments)
      .where(and(...conditions))
      .orderBy(
        request.direction === "forward"
          ? asc(spConversationTerminalSegments.firstPosition)
          : desc(spConversationTerminalSegments.firstPosition),
      )
      .limit(request.maxRecords + 1);
  } else {
    const [executionId, taskId] = scope;
    const table =
      request.collection === DurableCollections.executionJournalSegments
        ? spExecutionJournalSegments
        : spExecutionReplaySegments;
    const conditions: SQL[] = [eq(table.executionId, executionId!), eq(table.taskId, taskId!)];
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
    rows = await database
      .select()
      .from(table)
      .where(and(...conditions))
      .orderBy(
        request.direction === "forward" ? asc(table.firstSequence) : desc(table.firstSequence),
      )
      .limit(request.maxRecords + 1);
  }
  const after = request.after === null ? null : BigInt(request.after);
  const through = request.through === undefined ? null : BigInt(request.through);
  const records = [];
  let bytes = 0;
  let more = false;
  for (const row of rows) {
    const position =
      "position" in row
        ? row.position
        : "minPosition" in row
          ? row.minPosition
          : "firstPosition" in row
            ? row.firstPosition
            : row.firstSequence;
    const numeric = BigInt(position);
    if (after !== null && (request.direction === "forward" ? numeric <= after : numeric >= after)) {
      continue;
    }
    if (
      through !== null &&
      (request.direction === "forward" ? numeric > through : numeric < through)
    ) {
      continue;
    }
    const record =
      request.collection === DurableCollections.conversationPublicRootIndex
        ? (() => {
            const entry = publicRootIndexFromRow(row as PublicRootIndexRow);
            return immutableRecord(
              request.collection,
              conversationKeys.publicRootIndex(entry.conversationId, entry.position),
              canonicalSnapshot(entry).sha,
              encodeArchivedPublicRootIndex(entry),
            );
          })()
        : request.collection === DurableCollections.conversationPublicSegments
          ? immutableRecord(
              request.collection,
              conversationKeys.publicSegment(row.segmentId),
              row.contentHash,
              encodePublicSegment(publicFromRow(row as PublicRow)),
            )
          : request.collection === DurableCollections.conversationTerminalSegments
            ? immutableRecord(
                request.collection,
                conversationKeys.terminalSegment(row.segmentId),
                row.contentHash,
                encodeTerminalSegment(terminalFromRow(row as TerminalRow)),
              )
            : immutableRecord(
                request.collection,
                executionKeys.segment(row.segmentId),
                row.contentHash,
                privateEnvelopeFromRow(row as PrivateRow),
              );
    if (
      records.length >= request.maxRecords ||
      bytes + record.value.byteLength > request.maxStoredBytes
    ) {
      more = true;
      break;
    }
    records.push({ ...record, position, storedBytes: record.value.byteLength });
    bytes += record.value.byteLength;
  }
  return { records, nextCursor: more && records.length > 0 ? records.at(-1)!.position : null };
}

export function createPostgresDurableKernel(options: {
  database: Database;
  transactionRunner?: TransactionRunner<Database>;
  faultInjection?: (point: string) => void;
}): DurableKernel {
  const database = options.database as Database;
  const transactionRunner =
    options.transactionRunner ??
    ({
      transaction<T>(body: (transaction: Database) => T | Promise<T>): Operation<T> {
        return call(async () =>
          database.transaction(async (transaction) => body(transaction as unknown as Database)),
        );
      },
    } as TransactionRunner<Database>);
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
      // The repository checks the head before and after this wake-up hint.
      // Do not multiply one wait into repeated payload reads and connections.
      yield* sleep(Math.max(0, request.timeoutMs));
    },
    *apply(mutation): Operation<DurableMutationOutcome> {
      validateMutationStructure(mutation);
      return yield* transactionRunner.transaction((transaction) =>
        applyIn(transaction, mutation, options.faultInjection),
      );
    },
  };
}
