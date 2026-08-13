import {
  canonicalJson,
  canonicalSnapshot,
  parseJsonText,
  sha256Bytes,
  type Json,
} from "@sweatpants/foundation";
import {
  assertCheckpointPayload,
  checkpointHotRoots,
  checkpointHotSealedRootCount,
  rootPayloadBytes,
} from "@sweatpants/history-store";
import { and, asc, eq, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { call, sleep, type Operation } from "effection";
import { assertCheckpointBounds } from "./checkpoint-bounds.ts";
import {
  StorageError,
  type CheckpointPointer,
  type CommandAdmissionRequest,
  type CommandAdmissionResult,
  type CommandReceipt,
  type ConversationHead,
  type ConversationHeadProposal,
  type ConversationStore,
  type CommitExecutionRequest,
  type CommitExecutionResult,
  type ExecutionControl,
  type ExecutionObjectPointer,
  type ExecutionStore,
  type HeadCommitResult,
  type HistoryPointer,
  type PrivateSegmentPointer,
  type PublicArchivePointer,
  type StoredCheckpoint,
  type StoredExecutionObject,
  type StoredPrivateSegment,
  type StoredPublicArchiveSegment,
  type StoredTerminalSegment,
  type TerminalHistoryPage,
  type PublicArchivePage,
} from "./contract.ts";
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

export interface SqliteStorage {
  readonly conversationStore: ConversationStore;
  readonly executionStore: ExecutionStore;
}

type HeadRow = typeof spConversationHeads.$inferSelect;
type ReceiptRow = typeof spConversationCommandReceipts.$inferSelect;
type CheckpointRow = typeof spConversationCheckpoints.$inferSelect;
type PublicSegmentRow = typeof spConversationPublicSegments.$inferSelect;
type TerminalSegmentRow = typeof spConversationTerminalSegments.$inferSelect;
type ExecutionControlRow = typeof spExecutionControl.$inferSelect;
type JournalSegmentRow = typeof spExecutionJournalSegments.$inferSelect;
type ReplaySegmentRow = typeof spExecutionReplaySegments.$inferSelect;
type ExecutionObjectRow = typeof spExecutionObjects.$inferSelect;

type HeadDatabase = Pick<
  SweatpantsSqliteDatabase<SQLiteResultKind, unknown>,
  "select" | "insert" | "update"
>;

function invalid(message: string): never {
  throw new StorageError("persisted_data_invalid", message);
}

async function resolved<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

function numberValue(value: number | bigint, field: string): number {
  const normalized = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    return invalid(`${field} is outside the safe number range`);
  }
  return normalized;
}

function counterValue(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) return invalid(`${field} is not a decimal counter`);
  try {
    return BigInt(value);
  } catch (error) {
    return invalid(
      `${field} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseNullable(text: string | null, field: string): Json | null {
  if (text === null) {
    return null;
  }
  try {
    return parseJsonText(text, field);
  } catch (error) {
    return invalid(
      `${field} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseState(value: string): ConversationHead["state"] {
  if (
    value === "idle" ||
    value === "running" ||
    value === "parked" ||
    value === "recovering" ||
    value === "deleted"
  ) {
    return value;
  }
  return invalid(`unknown conversation state ${value}`);
}

function decodeReceipt(row: ReceiptRow): CommandReceipt {
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

async function decodeHead(row: HeadRow, database?: HeadDatabase): Promise<ConversationHead> {
  const terminal =
    row.terminalSegmentId === null || database === undefined
      ? undefined
      : await selectTerminalSegment(database, row.terminalSegmentId, row.conversationId);
  if (row.terminalSegmentId !== null && terminal === undefined) {
    return invalid(
      `Head ${row.conversationId} points to missing terminal segment ${row.terminalSegmentId}`,
    );
  }
  return {
    conversationId: row.conversationId,
    revision: row.revision,
    ownerEpoch: row.ownerEpoch,
    ownerRoute: parseNullable(row.ownerRouteJson, "owner_route_json"),
    state: parseState(row.state),
    checkpoint: row.checkpointId === null ? null : { checkpointId: row.checkpointId },
    terminalHistory:
      row.terminalSegmentId === null
        ? null
        : {
            segmentId: row.terminalSegmentId,
            lastPosition: terminal?.lastPosition ?? "0",
          },
    activeLogicalTurnId: row.activeLogicalTurnId,
    activeExecutionId: row.activeExecutionId,
    latestCompletedExecutionId: row.latestCompletedExecutionId,
    activeSegment: parseNullable(row.activeSegmentJson, "active_segment_json"),
    activeCommand: parseNullable(row.activeCommandJson, "active_command_json"),
    deletedAt: row.deletedAt === null ? null : numberValue(row.deletedAt, "deleted_at"),
    updatedAt: numberValue(row.updatedAt, "updated_at"),
  };
}

function encodeNullable(value: Json | null): string | null {
  return value === null ? null : canonicalJson(value);
}

function toHeadValues(
  proposal: ConversationHeadProposal,
  currentOwnerRoute: Json | null = null,
): {
  readonly ownerRouteJson: string | null;
  readonly state: string;
  readonly checkpointId: string | null;
  readonly terminalSegmentId: string | null;
  readonly activeLogicalTurnId: string | null;
  readonly activeExecutionId: string | null;
  readonly latestCompletedExecutionId: string | null;
  readonly activeSegmentJson: string | null;
  readonly activeCommandJson: string | null;
  readonly deletedAt: number | null;
} {
  if (proposal.state === "deleted" && proposal.deletedAt === null) {
    throw new Error("deleted conversation heads require deletedAt");
  }
  if (proposal.state !== "deleted" && proposal.deletedAt !== null) {
    throw new Error("non-deleted conversation heads cannot have deletedAt");
  }
  if (proposal.state === "deleted" && proposal.ownerTransition.kind !== "clear") {
    throw new Error("deleted conversation heads require a cleared owner");
  }
  return {
    ownerRouteJson:
      proposal.ownerTransition.kind === "assign"
        ? canonicalJson(proposal.ownerTransition.ownerRoute)
        : proposal.ownerTransition.kind === "preserve"
          ? encodeNullable(currentOwnerRoute)
          : null,
    state: proposal.state,
    checkpointId: proposal.checkpoint?.checkpointId ?? null,
    terminalSegmentId: proposal.terminalHistory?.segmentId ?? null,
    activeLogicalTurnId: proposal.activeLogicalTurnId,
    activeExecutionId: proposal.activeExecutionId,
    latestCompletedExecutionId: proposal.latestCompletedExecutionId,
    activeSegmentJson: encodeNullable(proposal.activeSegment),
    activeCommandJson: encodeNullable(proposal.activeCommand),
    deletedAt: proposal.deletedAt,
  };
}

async function selectHead(
  database: HeadDatabase,
  conversationId: string,
): Promise<HeadRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationHeads)
      .where(eq(spConversationHeads.conversationId, conversationId))
      .get() as HeadRow | undefined | Promise<HeadRow | undefined>,
  );
}

async function selectReceipt(
  database: HeadDatabase,
  conversationId: string,
  commandId: string,
): Promise<ReceiptRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationCommandReceipts)
      .where(
        and(
          eq(spConversationCommandReceipts.conversationId, conversationId),
          eq(spConversationCommandReceipts.commandId, commandId),
        ),
      )
      .get() as ReceiptRow | undefined | Promise<ReceiptRow | undefined>,
  );
}

async function selectCheckpoint(
  database: HeadDatabase,
  checkpointId: string,
): Promise<CheckpointRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationCheckpoints)
      .where(eq(spConversationCheckpoints.checkpointId, checkpointId))
      .get() as CheckpointRow | undefined | Promise<CheckpointRow | undefined>,
  );
}

async function selectCheckpointByCause(
  database: HeadDatabase,
  conversationId: string,
  causeKey: string,
): Promise<CheckpointRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationCheckpoints)
      .where(
        and(
          eq(spConversationCheckpoints.conversationId, conversationId),
          eq(spConversationCheckpoints.causeKey, causeKey),
        ),
      )
      .get() as CheckpointRow | undefined | Promise<CheckpointRow | undefined>,
  );
}

function decodeCheckpoint(row: CheckpointRow): StoredCheckpoint {
  const cause = parseJsonText(row.causeJson, "cause_json");
  const payload = parseJsonText(row.payloadJson, "payload_json");
  assertCheckpointPayload(payload);
  const encoded = canonicalSnapshot(payload);
  if (encoded.sha !== row.contentHash) {
    return invalid(`Checkpoint ${row.checkpointId} content hash does not match payload`);
  }
  const encodedBytes = new TextEncoder().encode(encoded.canonical).byteLength;
  if (encodedBytes !== numberValue(row.encodedBytes, "encoded_bytes")) {
    return invalid(`Checkpoint ${row.checkpointId} encoded byte count is invalid`);
  }
  const roots = checkpointHotRoots(payload);
  const sealedRootCount = checkpointHotSealedRootCount(payload);
  const continuation =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload["continuation"]
      : undefined;
  const openInterrupts =
    continuation && typeof continuation === "object" && !Array.isArray(continuation)
      ? continuation["openInterrupts"]
      : undefined;
  assertCheckpointBounds({
    encodedBytes,
    totalRoots: roots.length,
    mutableRoots: roots.length - sealedRootCount,
    openInterrupts: Array.isArray(openInterrupts) ? openInterrupts.length : 0,
    largestInlineRootBytes: Math.max(
      0,
      ...roots.map((root) => new TextEncoder().encode(canonicalJson(root)).byteLength),
    ),
  });
  return {
    checkpointId: row.checkpointId,
    conversationId: row.conversationId,
    causeKey: row.causeKey,
    cause,
    contentHash: row.contentHash,
    archiveHead:
      row.archiveHeadSegmentId === null
        ? null
        : { segmentId: row.archiveHeadSegmentId, lastPosition: row.archiveThroughPosition },
    archiveThroughPosition: row.archiveThroughPosition,
    payload,
    encodedBytes,
    createdAt: numberValue(row.createdAt, "created_at"),
  };
}

async function putCheckpoint(
  database: HeadDatabase,
  checkpoint: StoredCheckpoint,
): Promise<CheckpointPointer> {
  assertCheckpointPayload(checkpoint.payload);
  const sameId = await selectCheckpoint(database, checkpoint.checkpointId);
  if (sameId !== undefined) {
    if (sameId.contentHash !== checkpoint.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Checkpoint ${checkpoint.checkpointId} has another content hash`,
      );
    }
    return { checkpointId: sameId.checkpointId };
  }
  const existing = await selectCheckpointByCause(
    database,
    checkpoint.conversationId,
    checkpoint.causeKey,
  );
  if (existing !== undefined) {
    if (existing.contentHash !== checkpoint.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Checkpoint ${checkpoint.conversationId}/${checkpoint.causeKey} has another content hash`,
      );
    }
    return { checkpointId: existing.checkpointId };
  }

  const cause = canonicalSnapshot(checkpoint.cause);
  const payload = canonicalSnapshot(checkpoint.payload);
  if (payload.sha !== checkpoint.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Checkpoint ${checkpoint.checkpointId} content hash does not match payload`,
    );
  }
  const encodedBytes = new TextEncoder().encode(payload.canonical).byteLength;
  if (encodedBytes !== checkpoint.encodedBytes) {
    throw new StorageError(
      "persisted_data_invalid",
      `Checkpoint ${checkpoint.checkpointId} encoded byte count does not match payload`,
    );
  }
  const roots = checkpointHotRoots(payload.value);
  const sealedRootCount = checkpointHotSealedRootCount(payload.value);
  const continuation =
    payload.value && typeof payload.value === "object" && !Array.isArray(payload.value)
      ? payload.value["continuation"]
      : undefined;
  const openInterrupts =
    continuation && typeof continuation === "object" && !Array.isArray(continuation)
      ? continuation["openInterrupts"]
      : undefined;
  assertCheckpointBounds({
    encodedBytes,
    totalRoots: roots.length,
    mutableRoots: roots.length - sealedRootCount,
    openInterrupts: Array.isArray(openInterrupts) ? openInterrupts.length : 0,
    largestInlineRootBytes: Math.max(
      0,
      ...roots.map((root) => new TextEncoder().encode(canonicalJson(root)).byteLength),
    ),
  });
  const inserted = await resolved(
    database
      .insert(spConversationCheckpoints)
      .values({
        checkpointId: checkpoint.checkpointId,
        conversationId: checkpoint.conversationId,
        causeKey: checkpoint.causeKey,
        causeJson: cause.canonical,
        contentHash: checkpoint.contentHash,
        archiveHeadSegmentId: checkpoint.archiveHead?.segmentId ?? null,
        archiveThroughPosition: checkpoint.archiveThroughPosition,
        payloadJson: payload.canonical,
        encodedBytes: checkpoint.encodedBytes,
        createdAt: checkpoint.createdAt,
      })
      .returning()
      .get() as CheckpointRow | Promise<CheckpointRow>,
  );
  return { checkpointId: inserted.checkpointId };
}

async function selectPublicSegment(
  database: HeadDatabase,
  segmentId: string,
  conversationId?: string,
): Promise<PublicSegmentRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationPublicSegments)
      .where(
        conversationId === undefined
          ? eq(spConversationPublicSegments.segmentId, segmentId)
          : and(
              eq(spConversationPublicSegments.segmentId, segmentId),
              eq(spConversationPublicSegments.conversationId, conversationId),
            ),
      )
      .get() as PublicSegmentRow | undefined | Promise<PublicSegmentRow | undefined>,
  );
}

function decodeRoots(row: PublicSegmentRow): readonly Json[] {
  const parsed = parseJsonText(row.rootsJson, "roots_json");
  if (!Array.isArray(parsed)) {
    return invalid(`roots_json must contain an array`);
  }
  const encoded = canonicalSnapshot(parsed);
  if (encoded.sha !== row.contentHash) {
    return invalid(`Public archive segment ${row.segmentId} content hash does not match roots`);
  }
  if (
    new TextEncoder().encode(encoded.canonical).byteLength !==
    numberValue(row.encodedBytes, "encoded_bytes")
  ) {
    return invalid(`Public archive segment ${row.segmentId} encoded byte count is invalid`);
  }
  const payloadBytes = rootPayloadBytes(parsed);
  const singletonLegal = parsed.length === 1 && payloadBytes <= 1024 * 1024;
  if (parsed.length > 100 || (payloadBytes > 1024 * 1024 && !singletonLegal)) {
    return invalid(`Public archive segment ${row.segmentId} exceeds its production bound`);
  }
  return parsed;
}

async function putPublicArchiveSegment(
  database: HeadDatabase,
  segment: StoredPublicArchiveSegment,
): Promise<PublicArchivePointer> {
  const existing = await selectPublicSegment(database, segment.segmentId);
  if (existing !== undefined) {
    if (existing.contentHash !== segment.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Public archive segment ${segment.segmentId} has another content hash`,
      );
    }
    return { segmentId: existing.segmentId, lastPosition: existing.lastPosition };
  }

  const roots = canonicalSnapshot(segment.roots);
  if (roots.sha !== segment.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Public archive segment ${segment.segmentId} content hash does not match roots`,
    );
  }
  const encodedBytes = new TextEncoder().encode(roots.canonical).byteLength;
  if (encodedBytes !== segment.encodedBytes) {
    throw new StorageError(
      "persisted_data_invalid",
      `Public archive segment ${segment.segmentId} encoded byte count does not match roots`,
    );
  }
  const payloadBytes = rootPayloadBytes(segment.roots);
  const singletonLegal = segment.roots.length === 1 && payloadBytes <= 1024 * 1024;
  if (segment.roots.length > 100 || (payloadBytes > 1024 * 1024 && !singletonLegal)) {
    throw new StorageError(
      "persisted_data_invalid",
      `Public archive segment ${segment.segmentId} exceeds its production bound`,
    );
  }
  const inserted = await resolved(
    database
      .insert(spConversationPublicSegments)
      .values({
        segmentId: segment.segmentId,
        conversationId: segment.conversationId,
        previousSegmentId: segment.previous?.segmentId ?? null,
        firstPosition: segment.firstPosition,
        lastPosition: segment.lastPosition,
        rootsJson: roots.canonical,
        contentHash: segment.contentHash,
        encodedBytes: segment.encodedBytes,
        createdAt: segment.createdAt,
      })
      .returning()
      .get() as PublicSegmentRow | Promise<PublicSegmentRow>,
  );
  return { segmentId: inserted.segmentId, lastPosition: inserted.lastPosition };
}

async function allPublicSegments(
  database: HeadDatabase,
  conversationId: string,
): Promise<PublicSegmentRow[]> {
  return (await resolved(
    database
      .select()
      .from(spConversationPublicSegments)
      .where(eq(spConversationPublicSegments.conversationId, conversationId))
      .orderBy(
        asc(spConversationPublicSegments.firstPosition),
        asc(spConversationPublicSegments.segmentId),
      )
      .all() as PublicSegmentRow[] | Promise<PublicSegmentRow[]>,
  )) as PublicSegmentRow[];
}

async function authoritativePublicSegments(
  database: HeadDatabase,
  conversationId: string,
): Promise<{
  readonly rows: readonly PublicSegmentRow[];
  readonly head: PublicArchivePointer | null;
}> {
  const conversationHead = await selectHead(database, conversationId);
  if (conversationHead === undefined) {
    const rows = await allPublicSegments(database, conversationId);
    validatePublicRanges(rows);
    return {
      rows,
      head:
        rows.at(-1) === undefined
          ? null
          : {
              segmentId: rows.at(-1)!.segmentId,
              lastPosition: rows.at(-1)!.lastPosition,
            },
    };
  }
  if (conversationHead.checkpointId === null) {
    return { rows: [], head: null };
  }
  const checkpoint = await selectCheckpoint(database, conversationHead.checkpointId);
  if (checkpoint === undefined) {
    return invalid(
      `Head ${conversationId} points to missing checkpoint ${conversationHead.checkpointId}`,
    );
  }
  if (checkpoint.archiveHeadSegmentId === null) {
    return { rows: [], head: null };
  }

  const reverse: PublicSegmentRow[] = [];
  const seen = new Set<string>();
  let segmentId: string | null = checkpoint.archiveHeadSegmentId;
  while (segmentId !== null) {
    if (seen.has(segmentId)) {
      return invalid(`Public archive chain contains a cycle at ${segmentId}`);
    }
    seen.add(segmentId);
    const row = await selectPublicSegment(database, segmentId, conversationId);
    if (row === undefined) {
      return invalid(`Public archive chain points to missing segment ${segmentId}`);
    }
    reverse.push(row);
    segmentId = row.previousSegmentId;
  }
  const rows = reverse.reverse();
  validatePublicRanges(rows);
  const head = {
    segmentId: checkpoint.archiveHeadSegmentId,
    lastPosition: checkpoint.archiveThroughPosition,
  };
  if (rows.at(-1)?.lastPosition !== head.lastPosition) {
    return invalid(`Checkpoint archive frontier does not match its archive head`);
  }
  return { rows, head };
}

function validatePublicRanges(rows: readonly PublicSegmentRow[]): void {
  let expected: bigint | null = null;
  for (const row of rows) {
    const roots = decodeRoots(row);
    const first = counterValue(row.firstPosition, "first_position");
    const last = counterValue(row.lastPosition, "last_position");
    if (last < first || last - first + 1n !== BigInt(roots.length)) {
      return invalid(`Public archive segment ${row.segmentId} has an invalid position range`);
    }
    if (expected !== null && first !== expected) {
      return invalid(`Public archive segment ${row.segmentId} is not contiguous at ${expected}`);
    }
    expected = last + 1n;
  }
}

function pagePublicRows(
  rows: readonly PublicSegmentRow[],
  head: PublicArchivePointer | null,
  cursor: string | undefined,
  limit: number,
): PublicArchivePage {
  const start = cursor === undefined ? 0n : counterValue(cursor, "archive_cursor");
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new StorageError(
      "persisted_data_invalid",
      `Invalid public archive page ${cursor}/${limit}`,
    );
  }
  const all: Json[] = [];
  const first = rows.length === 0 ? 0n : counterValue(rows[0]!.firstPosition, "first_position");
  for (const row of rows) {
    all.push(...decodeRoots(row));
  }
  const end = first + BigInt(all.length);
  if (start < first || start > end) {
    throw new StorageError(
      "persisted_data_invalid",
      `Archive cursor ${start} is outside its chain`,
    );
  }
  const offsetValue = start - first;
  if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorageError("persisted_data_invalid", `Archive cursor ${start} is too large`);
  }
  const offset = Number(offsetValue);
  const values = all.slice(offset, offset + limit);
  const next = start + BigInt(values.length);
  return {
    roots: values,
    nextCursor: next < end ? next.toString(10) : null,
    head,
  };
}

async function readPublicArchivePage(
  database: HeadDatabase,
  conversationId: string,
  cursor: string | undefined,
  limit = 50,
): Promise<PublicArchivePage> {
  const authoritative = await authoritativePublicSegments(database, conversationId);
  return pagePublicRows(authoritative.rows, authoritative.head, cursor, limit);
}

async function selectTerminalSegment(
  database: HeadDatabase,
  segmentId: string,
  conversationId?: string,
): Promise<TerminalSegmentRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationTerminalSegments)
      .where(
        conversationId === undefined
          ? eq(spConversationTerminalSegments.segmentId, segmentId)
          : and(
              eq(spConversationTerminalSegments.segmentId, segmentId),
              eq(spConversationTerminalSegments.conversationId, conversationId),
            ),
      )
      .get() as TerminalSegmentRow | undefined | Promise<TerminalSegmentRow | undefined>,
  );
}

async function selectTerminalByPublication(
  database: HeadDatabase,
  conversationId: string,
  publicationKey: string,
): Promise<TerminalSegmentRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spConversationTerminalSegments)
      .where(
        and(
          eq(spConversationTerminalSegments.conversationId, conversationId),
          eq(spConversationTerminalSegments.publicationKey, publicationKey),
        ),
      )
      .get() as TerminalSegmentRow | undefined | Promise<TerminalSegmentRow | undefined>,
  );
}

function decodeEntries(row: TerminalSegmentRow): readonly Json[] {
  const parsed = parseJsonText(row.entriesJson, "entries_json");
  if (!Array.isArray(parsed)) {
    return invalid("entries_json must contain an array");
  }
  if (canonicalSnapshot(parsed).sha !== row.contentHash) {
    return invalid(`Terminal segment ${row.segmentId} content hash does not match entries`);
  }
  return parsed;
}

async function putTerminalHistorySegment(
  database: HeadDatabase,
  segment: StoredTerminalSegment,
): Promise<HistoryPointer> {
  const existing = await selectTerminalByPublication(
    database,
    segment.conversationId,
    segment.publicationKey,
  );
  if (existing !== undefined) {
    if (existing.contentHash !== segment.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Terminal publication ${segment.conversationId}/${segment.publicationKey} has another content hash`,
      );
    }
    return { segmentId: existing.segmentId, lastPosition: existing.lastPosition };
  }
  const sameId = await selectTerminalSegment(database, segment.segmentId);
  if (sameId !== undefined) {
    if (sameId.contentHash !== segment.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Terminal segment ${segment.segmentId} has another content hash`,
      );
    }
    return { segmentId: sameId.segmentId, lastPosition: sameId.lastPosition };
  }

  const entries = canonicalSnapshot(segment.entries);
  if (entries.sha !== segment.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Terminal segment ${segment.segmentId} content hash does not match entries`,
    );
  }
  const inserted = await resolved(
    database
      .insert(spConversationTerminalSegments)
      .values({
        segmentId: segment.segmentId,
        conversationId: segment.conversationId,
        logicalTurnId: segment.logicalTurnId,
        executionId: segment.executionId,
        publicationKey: segment.publicationKey,
        previousSegmentId: segment.previous?.segmentId ?? null,
        firstPosition: segment.firstPosition,
        lastPosition: segment.lastPosition,
        entriesJson: entries.canonical,
        contentHash: segment.contentHash,
        createdAt: segment.createdAt,
      })
      .returning()
      .get() as TerminalSegmentRow | Promise<TerminalSegmentRow>,
  );
  return { segmentId: inserted.segmentId, lastPosition: inserted.lastPosition };
}

async function allTerminalSegments(
  database: HeadDatabase,
  conversationId: string,
): Promise<TerminalSegmentRow[]> {
  return (await resolved(
    database
      .select()
      .from(spConversationTerminalSegments)
      .where(eq(spConversationTerminalSegments.conversationId, conversationId))
      .orderBy(
        asc(spConversationTerminalSegments.firstPosition),
        asc(spConversationTerminalSegments.segmentId),
      )
      .all() as TerminalSegmentRow[] | Promise<TerminalSegmentRow[]>,
  )) as TerminalSegmentRow[];
}

async function authoritativeTerminalSegments(
  database: HeadDatabase,
  conversationId: string,
): Promise<{ readonly rows: readonly TerminalSegmentRow[]; readonly head: HistoryPointer | null }> {
  const conversationHead = await selectHead(database, conversationId);
  if (conversationHead === undefined) {
    const rows = await allTerminalSegments(database, conversationId);
    validateTerminalRanges(rows);
    return {
      rows,
      head:
        rows.at(-1) === undefined
          ? null
          : {
              segmentId: rows.at(-1)!.segmentId,
              lastPosition: rows.at(-1)!.lastPosition,
            },
    };
  }
  if (conversationHead.terminalSegmentId === null) {
    return { rows: [], head: null };
  }

  const reverse: TerminalSegmentRow[] = [];
  const seen = new Set<string>();
  let segmentId: string | null = conversationHead.terminalSegmentId;
  while (segmentId !== null) {
    if (seen.has(segmentId)) {
      return invalid(`Terminal history chain contains a cycle at ${segmentId}`);
    }
    seen.add(segmentId);
    const row = await selectTerminalSegment(database, segmentId, conversationId);
    if (row === undefined) {
      return invalid(`Terminal history chain points to missing segment ${segmentId}`);
    }
    reverse.push(row);
    segmentId = row.previousSegmentId;
  }
  const rows = reverse.reverse();
  validateTerminalRanges(rows);
  const head = {
    segmentId: conversationHead.terminalSegmentId,
    lastPosition: rows.at(-1)?.lastPosition ?? "0",
  };
  return { rows, head };
}

function validateTerminalRanges(rows: readonly TerminalSegmentRow[]): void {
  let expected: bigint | null = null;
  for (const row of rows) {
    const entries = decodeEntries(row);
    const first = counterValue(row.firstPosition, "first_position");
    const last = counterValue(row.lastPosition, "last_position");
    if (last < first || last - first + 1n !== BigInt(entries.length)) {
      return invalid(`Terminal segment ${row.segmentId} has an invalid position range`);
    }
    if (expected !== null && first !== expected) {
      return invalid(`Terminal segment ${row.segmentId} is not contiguous at ${expected}`);
    }
    expected = last + 1n;
  }
}

function pageTerminalRows(
  rows: readonly TerminalSegmentRow[],
  head: HistoryPointer | null,
  cursor: string | undefined,
  limit: number,
): TerminalHistoryPage {
  const start = cursor === undefined ? 0n : counterValue(cursor, "terminal_cursor");
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new StorageError(
      "persisted_data_invalid",
      `Invalid terminal history page ${cursor}/${limit}`,
    );
  }
  const all: Json[] = [];
  const first = rows.length === 0 ? 0n : counterValue(rows[0]!.firstPosition, "first_position");
  for (const row of rows) {
    all.push(...decodeEntries(row));
  }
  const end = first + BigInt(all.length);
  if (start < first || start > end) {
    throw new StorageError(
      "persisted_data_invalid",
      `Terminal cursor ${start} is outside its chain`,
    );
  }
  const offsetValue = start - first;
  if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new StorageError("persisted_data_invalid", `Terminal cursor ${start} is too large`);
  }
  const offset = Number(offsetValue);
  const values = all.slice(offset, offset + limit);
  const next = start + BigInt(values.length);
  return {
    entries: values,
    nextCursor: next < end ? next.toString(10) : null,
    head,
  };
}

async function readTerminalHistoryPage(
  database: HeadDatabase,
  conversationId: string,
  cursor: string | undefined,
  limit = 50,
): Promise<TerminalHistoryPage> {
  const authoritative = await authoritativeTerminalSegments(database, conversationId);
  return pageTerminalRows(authoritative.rows, authoritative.head, cursor, limit);
}

async function commitHead(
  database: HeadDatabase,
  conversationId: string,
  expectedRevision: string | null,
  expectedOwnerEpoch: string | null,
  proposal: ConversationHeadProposal,
  now: number,
): Promise<HeadCommitResult> {
  const current = await selectHead(database, conversationId);
  if (current === undefined) {
    if (expectedRevision !== null || expectedOwnerEpoch !== null) {
      return { status: "head_conflict", current: null };
    }
    const values = toHeadValues(proposal);
    const inserted = await resolved(
      database
        .insert(spConversationHeads)
        .values({
          conversationId,
          revision: "0",
          ownerEpoch: "0",
          ...values,
          updatedAt: now,
        })
        .returning()
        .get() as HeadRow | Promise<HeadRow>,
    );
    return { status: "committed", head: await decodeHead(inserted, database) };
  }

  if (current.revision !== expectedRevision || current.ownerEpoch !== expectedOwnerEpoch) {
    return { status: "head_conflict", current: await decodeHead(current, database) };
  }

  const values = toHeadValues(proposal, parseNullable(current.ownerRouteJson, "owner_route_json"));
  const ownerEpoch =
    proposal.ownerTransition.kind === "assign"
      ? sql`${spConversationHeads.ownerEpoch} + 1`
      : spConversationHeads.ownerEpoch;
  const updated = await resolved(
    database
      .update(spConversationHeads)
      .set({
        ...values,
        revision: sql`${spConversationHeads.revision} + 1`,
        ownerEpoch,
        updatedAt: now,
      })
      .where(
        sql`${spConversationHeads.conversationId} = ${conversationId}
        AND ${spConversationHeads.revision} = ${current.revision}
        AND ${spConversationHeads.ownerEpoch} = ${current.ownerEpoch}`,
      )
      .returning()
      .get() as HeadRow | undefined | Promise<HeadRow | undefined>,
  );
  if (updated === undefined) {
    const winner = await selectHead(database, conversationId);
    return {
      status: "head_conflict",
      current: winner ? await decodeHead(winner, database) : null,
    };
  }
  return { status: "committed", head: await decodeHead(updated, database) };
}

async function admitCommand(
  database: HeadDatabase,
  request: CommandAdmissionRequest,
  now: number,
  faultInjection?: (point: string) => void,
): Promise<CommandAdmissionResult> {
  const current = await selectHead(database, request.conversationId);
  const existing = await selectReceipt(database, request.conversationId, request.commandId);
  if (existing !== undefined) {
    const receipt = decodeReceipt(existing);
    if (receipt.commandDigest !== request.commandDigest) {
      return { status: "command_identity_conflict", receipt };
    }
    return {
      status: "idempotent",
      receipt,
      head:
        current === undefined
          ? invalid("receipt exists without a conversation head")
          : await decodeHead(current, database),
    };
  }

  if (current === undefined || current.revision !== request.expectedRevision) {
    return {
      status: "head_conflict",
      current: current === undefined ? null : await decodeHead(current, database),
    };
  }

  if (current.state !== "idle") {
    return { status: "state_conflict", current: await decodeHead(current, database) };
  }

  const resultingRevision = (BigInt(current.revision) + 1n).toString(10);
  const row = await resolved(
    database
      .insert(spConversationCommandReceipts)
      .values({
        conversationId: request.conversationId,
        commandId: request.commandId,
        commandDigest: request.commandDigest,
        participantId: request.participantId,
        acceptedAt: request.acceptedAt,
        retainUntil: request.retainUntil,
        admittedRevision: request.expectedRevision,
        resultingRevision,
        logicalTurnId: request.logicalTurnId,
        executionId: request.executionId,
      })
      .returning()
      .get() as ReceiptRow | Promise<ReceiptRow>,
  );
  faultInjection?.("command-after-receipt");

  const committed = await commitHead(
    database,
    request.conversationId,
    request.expectedRevision,
    current.ownerEpoch,
    request.proposal,
    now,
  );
  if (committed.status !== "committed") {
    return committed;
  }
  faultInjection?.("command-before-commit");
  return { status: "admitted", receipt: decodeReceipt(row), head: committed.head };
}

function createConversationStore(
  database: SweatpantsSqliteDatabase<SQLiteResultKind, unknown>,
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<SQLiteResultKind, unknown>>,
  faultInjection?: (point: string) => void,
): ConversationStore {
  return {
    *loadHead(conversationId): Operation<ConversationHead | null> {
      const row = yield* call(() => selectHead(database, conversationId));
      return row === undefined ? null : yield* call(() => decodeHead(row, database));
    },
    *compareAndSwapHead(
      conversationId,
      expectedRevision,
      expectedOwnerEpoch,
      proposal,
    ): Operation<HeadCommitResult> {
      return yield* call(() =>
        transactions.immediate((transaction) =>
          commitHead(
            transaction,
            conversationId,
            expectedRevision,
            expectedOwnerEpoch,
            proposal,
            Date.now(),
          ),
        ),
      );
    },
    *admitCommand(request: CommandAdmissionRequest): Operation<CommandAdmissionResult> {
      return yield* transactions.immediate((transaction) =>
        admitCommand(transaction, request, request.acceptedAt, faultInjection),
      );
    },
    *getCommandReceipt(
      conversationId: string,
      commandId: string,
    ): Operation<CommandReceipt | null> {
      const row = yield* call(() => selectReceipt(database, conversationId, commandId));
      return row === undefined ? null : decodeReceipt(row);
    },
    *putCheckpoint(checkpoint): Operation<CheckpointPointer> {
      return yield* transactions.immediate((transaction) => putCheckpoint(transaction, checkpoint));
    },
    *getCheckpoint(pointer): Operation<StoredCheckpoint | null> {
      const row = yield* call(() => selectCheckpoint(database, pointer.checkpointId));
      return row === undefined ? null : decodeCheckpoint(row);
    },
    *putPublicArchiveSegment(segment: StoredPublicArchiveSegment): Operation<PublicArchivePointer> {
      return yield* transactions.immediate((transaction) =>
        putPublicArchiveSegment(transaction, segment),
      );
    },
    *readPublicArchivePage(
      conversationId: string,
      cursor?: string,
      limit?: number,
    ): Operation<PublicArchivePage> {
      return yield* call(() => readPublicArchivePage(database, conversationId, cursor, limit));
    },
    *putTerminalHistorySegment(segment: StoredTerminalSegment): Operation<HistoryPointer> {
      return yield* transactions.immediate((transaction) =>
        putTerminalHistorySegment(transaction, segment),
      );
    },
    *readTerminalHistoryPage(
      conversationId: string,
      cursor?: string,
      limit?: number,
    ): Operation<TerminalHistoryPage> {
      return yield* call(() => readTerminalHistoryPage(database, conversationId, cursor, limit));
    },
    *watchHead(
      conversationId: string,
      afterRevision: string,
      timeoutMs: number,
    ): Operation<ConversationHead | null> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (true) {
        const row = yield* call(() => selectHead(database, conversationId));
        if (row !== undefined && BigInt(row.revision) > BigInt(afterRevision)) {
          return yield* call(() => decodeHead(row, database));
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return null;
        }
        yield* sleep(Math.min(remaining, 10));
      }
    },
  };
}

function parseExecutionStatus(value: string): ExecutionControl["status"] {
  if (value === "active" || value === "parked" || value === "cancelling" || value === "terminal") {
    return value;
  }
  return invalid(`unknown execution status ${value}`);
}

function parseDisposition(value: string | null): ExecutionControl["requestedDisposition"] {
  if (value === null || value === "cancelled" || value === "superseded") {
    return value;
  }
  return invalid(`unknown execution disposition ${value}`);
}

function decodeControl(row: ExecutionControlRow): ExecutionControl {
  return {
    executionId: row.executionId,
    controlRevision: row.controlRevision,
    ownerFence: row.ownerFence,
    status: parseExecutionStatus(row.status),
    rootTaskId: row.rootTaskId,
    stopGeneration: row.stopGeneration,
    requestedDisposition: parseDisposition(row.requestedDisposition),
    control: parseJsonText(row.controlJson, "control_json"),
    updatedAt: numberValue(row.updatedAt, "updated_at"),
  };
}

async function selectControl(
  database: HeadDatabase,
  executionId: string,
): Promise<ExecutionControlRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spExecutionControl)
      .where(eq(spExecutionControl.executionId, executionId))
      .get() as ExecutionControlRow | undefined | Promise<ExecutionControlRow | undefined>,
  );
}

function decodePrivateEntries(row: JournalSegmentRow | ReplaySegmentRow): readonly Json[] {
  const parsed = parseJsonText(row.entriesJson, "entries_json");
  if (!Array.isArray(parsed)) {
    return invalid("entries_json must contain an array");
  }
  const encoded = canonicalSnapshot(parsed);
  if (encoded.sha !== row.contentHash) {
    return invalid(`Private segment ${row.segmentId} content hash does not match entries`);
  }
  if (
    new TextEncoder().encode(encoded.canonical).byteLength !==
    numberValue(row.encodedBytes, "encoded_bytes")
  ) {
    return invalid(`Private segment ${row.segmentId} encoded byte count is invalid`);
  }
  const first = counterValue(row.firstSequence, "first_sequence");
  const last = counterValue(row.lastSequence, "last_sequence");
  if (last < first || last - first + 1n !== BigInt(parsed.length)) {
    return invalid(`Private segment ${row.segmentId} has an invalid sequence range`);
  }
  if (
    parsed.some((entry) => new TextEncoder().encode(canonicalJson(entry)).byteLength > 1024 * 1024)
  ) {
    return invalid(`Private segment ${row.segmentId} contains an oversized inline entry`);
  }
  return parsed;
}

async function selectJournal(
  database: HeadDatabase,
  executionId: string,
  taskId: string,
  segmentId: string,
): Promise<JournalSegmentRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spExecutionJournalSegments)
      .where(
        and(
          eq(spExecutionJournalSegments.executionId, executionId),
          eq(spExecutionJournalSegments.taskId, taskId),
          eq(spExecutionJournalSegments.segmentId, segmentId),
        ),
      )
      .get() as JournalSegmentRow | undefined | Promise<JournalSegmentRow | undefined>,
  );
}

async function selectReplay(
  database: HeadDatabase,
  executionId: string,
  taskId: string,
  segmentId: string,
): Promise<ReplaySegmentRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spExecutionReplaySegments)
      .where(
        and(
          eq(spExecutionReplaySegments.executionId, executionId),
          eq(spExecutionReplaySegments.taskId, taskId),
          eq(spExecutionReplaySegments.segmentId, segmentId),
        ),
      )
      .get() as ReplaySegmentRow | undefined | Promise<ReplaySegmentRow | undefined>,
  );
}

async function putJournalSegment(
  database: HeadDatabase,
  segment: StoredPrivateSegment,
): Promise<PrivateSegmentPointer> {
  const existing = await resolved(
    database
      .select()
      .from(spExecutionJournalSegments)
      .where(eq(spExecutionJournalSegments.segmentId, segment.segmentId))
      .get() as JournalSegmentRow | undefined | Promise<JournalSegmentRow | undefined>,
  );
  if (existing !== undefined) {
    if (existing.contentHash !== segment.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Journal segment ${segment.segmentId} has another content hash`,
      );
    }
    return { segmentId: existing.segmentId, lastSequence: existing.lastSequence };
  }
  const entries = canonicalSnapshot(segment.entries);
  if (entries.sha !== segment.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Journal segment ${segment.segmentId} content hash does not match entries`,
    );
  }
  const encodedBytes = new TextEncoder().encode(entries.canonical).byteLength;
  const largestEntryBytes = Math.max(
    0,
    ...segment.entries.map((entry) => new TextEncoder().encode(canonicalJson(entry)).byteLength),
  );
  if (largestEntryBytes > 1024 * 1024) {
    throw new StorageError(
      "segment_entry_too_large",
      `Journal segment ${segment.segmentId} contains an oversized inline entry`,
    );
  }
  if (encodedBytes !== segment.encodedBytes) {
    throw new StorageError(
      "persisted_data_invalid",
      `Journal segment ${segment.segmentId} byte count is invalid`,
    );
  }
  const inserted = await resolved(
    database
      .insert(spExecutionJournalSegments)
      .values({
        segmentId: segment.segmentId,
        executionId: segment.executionId,
        taskId: segment.taskId,
        previousSegmentId: segment.previous?.segmentId ?? null,
        firstSequence: segment.firstSequence,
        lastSequence: segment.lastSequence,
        entriesJson: entries.canonical,
        contentHash: segment.contentHash,
        encodedBytes: segment.encodedBytes,
        createdAt: segment.createdAt,
      })
      .returning()
      .get() as JournalSegmentRow | Promise<JournalSegmentRow>,
  );
  return { segmentId: inserted.segmentId, lastSequence: inserted.lastSequence };
}

async function putReplaySegment(
  database: HeadDatabase,
  segment: StoredPrivateSegment,
): Promise<PrivateSegmentPointer> {
  const existing = await resolved(
    database
      .select()
      .from(spExecutionReplaySegments)
      .where(eq(spExecutionReplaySegments.segmentId, segment.segmentId))
      .get() as ReplaySegmentRow | undefined | Promise<ReplaySegmentRow | undefined>,
  );
  if (existing !== undefined) {
    if (existing.contentHash !== segment.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Replay segment ${segment.segmentId} has another content hash`,
      );
    }
    return { segmentId: existing.segmentId, lastSequence: existing.lastSequence };
  }
  const entries = canonicalSnapshot(segment.entries);
  if (entries.sha !== segment.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Replay segment ${segment.segmentId} content hash does not match entries`,
    );
  }
  const encodedBytes = new TextEncoder().encode(entries.canonical).byteLength;
  const largestEntryBytes = Math.max(
    0,
    ...segment.entries.map((entry) => new TextEncoder().encode(canonicalJson(entry)).byteLength),
  );
  if (largestEntryBytes > 1024 * 1024) {
    throw new StorageError(
      "segment_entry_too_large",
      `Replay segment ${segment.segmentId} contains an oversized inline entry`,
    );
  }
  if (encodedBytes !== segment.encodedBytes) {
    throw new StorageError(
      "persisted_data_invalid",
      `Replay segment ${segment.segmentId} byte count is invalid`,
    );
  }
  const inserted = await resolved(
    database
      .insert(spExecutionReplaySegments)
      .values({
        segmentId: segment.segmentId,
        executionId: segment.executionId,
        taskId: segment.taskId,
        previousSegmentId: segment.previous?.segmentId ?? null,
        firstSequence: segment.firstSequence,
        lastSequence: segment.lastSequence,
        entriesJson: entries.canonical,
        contentHash: segment.contentHash,
        encodedBytes: segment.encodedBytes,
        createdAt: segment.createdAt,
      })
      .returning()
      .get() as ReplaySegmentRow | Promise<ReplaySegmentRow>,
  );
  return { segmentId: inserted.segmentId, lastSequence: inserted.lastSequence };
}

async function commitExecution(
  database: HeadDatabase,
  request: CommitExecutionRequest,
  faultInjection?: (point: string) => void,
): Promise<CommitExecutionResult> {
  const current = await selectControl(database, request.executionId);
  if (current === undefined) {
    if (request.expectedControlRevision !== null || request.expectedOwnerFence !== "0") {
      return { status: "control_conflict", current: null };
    }
    for (const segment of request.journalSegments ?? []) {
      await putJournalSegment(database, segment);
    }
    for (const segment of request.replaySegments ?? []) {
      await putReplaySegment(database, segment);
    }
    faultInjection?.("execution-after-segment-insert");
    const inserted = await resolved(
      database
        .insert(spExecutionControl)
        .values({
          executionId: request.nextControl.executionId,
          controlRevision: "0",
          ownerFence: request.nextControl.ownerFence,
          status: request.nextControl.status,
          rootTaskId: request.nextControl.rootTaskId,
          stopGeneration: request.nextControl.stopGeneration,
          requestedDisposition: request.nextControl.requestedDisposition,
          controlJson: canonicalJson(request.nextControl.control),
          updatedAt: request.updatedAt,
        })
        .returning()
        .get() as ExecutionControlRow | Promise<ExecutionControlRow>,
    );
    faultInjection?.("execution-before-commit");
    return { status: "committed", control: decodeControl(inserted) };
  }

  if (current.ownerFence !== request.expectedOwnerFence) {
    return { status: "stale_owner", current: decodeControl(current) };
  }
  if (current.controlRevision !== request.expectedControlRevision) {
    return { status: "control_conflict", current: decodeControl(current) };
  }
  for (const segment of request.journalSegments ?? []) {
    await putJournalSegment(database, segment);
  }
  for (const segment of request.replaySegments ?? []) {
    await putReplaySegment(database, segment);
  }
  faultInjection?.("execution-after-segment-insert");
  const updated = await resolved(
    database
      .update(spExecutionControl)
      .set({
        controlRevision: sql`${spExecutionControl.controlRevision} + 1`,
        ownerFence: request.nextControl.ownerFence,
        status: request.nextControl.status,
        rootTaskId: request.nextControl.rootTaskId,
        stopGeneration: request.nextControl.stopGeneration,
        requestedDisposition: request.nextControl.requestedDisposition,
        controlJson: canonicalJson(request.nextControl.control),
        updatedAt: request.updatedAt,
      })
      .where(
        and(
          eq(spExecutionControl.executionId, request.executionId),
          eq(spExecutionControl.controlRevision, current.controlRevision),
          eq(spExecutionControl.ownerFence, current.ownerFence),
        ),
      )
      .returning()
      .get() as ExecutionControlRow | undefined | Promise<ExecutionControlRow | undefined>,
  );
  if (updated === undefined) {
    const winner = await selectControl(database, request.executionId);
    return { status: "control_conflict", current: winner ? decodeControl(winner) : null };
  }
  faultInjection?.("execution-before-commit");
  return { status: "committed", control: decodeControl(updated) };
}

async function selectObject(
  database: HeadDatabase,
  objectId: string,
): Promise<ExecutionObjectRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spExecutionObjects)
      .where(eq(spExecutionObjects.objectId, objectId))
      .get() as ExecutionObjectRow | undefined | Promise<ExecutionObjectRow | undefined>,
  );
}

function decodeObject(row: ExecutionObjectRow): StoredExecutionObject {
  const hasJson = row.jsonBody !== null;
  const hasBlob = row.blobBody !== null;
  if (hasJson === hasBlob) {
    return invalid(`execution object ${row.objectId} has invalid body cardinality`);
  }
  if (row.lifetimeScope !== "execution" && row.lifetimeScope !== "conversation") {
    return invalid(`Execution object ${row.objectId} has an invalid lifetime scope`);
  }
  const body = hasJson ? parseJsonText(row.jsonBody!, "json_body") : new Uint8Array(row.blobBody!);
  const bytes =
    body instanceof Uint8Array ? body : new TextEncoder().encode(canonicalSnapshot(body).canonical);
  const contentHash = body instanceof Uint8Array ? sha256Bytes(bytes) : canonicalSnapshot(body).sha;
  if (contentHash !== row.contentHash) {
    return invalid(`Execution object ${row.objectId} content hash does not match body`);
  }
  if (bytes.byteLength !== numberValue(row.byteLength, "byte_length")) {
    return invalid(`Execution object ${row.objectId} byte length is invalid`);
  }
  return {
    objectId: row.objectId,
    lifetimeScope: row.lifetimeScope as StoredExecutionObject["lifetimeScope"],
    scopeOwnerId: row.scopeOwnerId,
    objectKind: row.objectKind,
    contentHash: row.contentHash,
    byteLength: bytes.byteLength,
    body,
    createdAt: numberValue(row.createdAt, "created_at"),
  };
}

async function putObject(
  database: HeadDatabase,
  object: StoredExecutionObject,
): Promise<ExecutionObjectPointer> {
  const existing = await selectObject(database, object.objectId);
  if (existing !== undefined) {
    if (existing.contentHash !== object.contentHash) {
      throw new StorageError(
        "immutable_object_conflict",
        `Execution object ${object.objectId} has another content hash`,
      );
    }
    return { objectId: existing.objectId };
  }
  const isBlob = object.body instanceof Uint8Array;
  const json = isBlob ? null : canonicalSnapshot(object.body as Json);
  const bytes = isBlob
    ? new Uint8Array(object.body as Uint8Array)
    : new TextEncoder().encode(json!.canonical);
  if (isBlob && sha256Bytes(bytes) !== object.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Execution object ${object.objectId} content hash does not match body`,
    );
  }
  if (!isBlob && json && json.sha !== object.contentHash) {
    throw new StorageError(
      "persisted_data_invalid",
      `Execution object ${object.objectId} content hash does not match body`,
    );
  }
  if (bytes.byteLength !== object.byteLength) {
    throw new StorageError(
      "persisted_data_invalid",
      `Execution object ${object.objectId} byte length is invalid`,
    );
  }
  const inserted = await resolved(
    database
      .insert(spExecutionObjects)
      .values({
        objectId: object.objectId,
        lifetimeScope: object.lifetimeScope,
        scopeOwnerId: object.scopeOwnerId,
        objectKind: object.objectKind,
        contentHash: object.contentHash,
        byteLength: object.byteLength,
        jsonBody: json?.canonical ?? null,
        blobBody: isBlob ? bytes : null,
        createdAt: object.createdAt,
      })
      .returning()
      .get() as ExecutionObjectRow | Promise<ExecutionObjectRow>,
  );
  return { objectId: inserted.objectId };
}

function createExecutionStore(
  database: SweatpantsSqliteDatabase<SQLiteResultKind, unknown>,
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<SQLiteResultKind, unknown>>,
  faultInjection?: (point: string) => void,
): ExecutionStore {
  async function* readPrivateChain(
    kind: "journal" | "replay",
    task: {
      readonly executionId: string;
      readonly taskId: string;
      readonly head: { readonly segmentId: string } | null;
    },
  ): AsyncIterable<readonly Json[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    let segmentId = task.head?.segmentId ?? null;
    while (segmentId !== null) {
      if (seen.has(segmentId)) {
        return invalid(`${kind} segment chain contains a cycle at ${segmentId}`);
      }
      seen.add(segmentId);
      const row =
        kind === "journal"
          ? await selectJournal(database, task.executionId, task.taskId, segmentId)
          : await selectReplay(database, task.executionId, task.taskId, segmentId);
      if (row === undefined) {
        return invalid(`${kind} segment ${segmentId} is missing or outside task scope`);
      }
      ids.push(row.segmentId);
      segmentId = row.previousSegmentId;
    }
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const row =
        kind === "journal"
          ? await selectJournal(database, task.executionId, task.taskId, ids[index]!)
          : await selectReplay(database, task.executionId, task.taskId, ids[index]!);
      if (row === undefined) {
        return invalid(`${kind} segment ${ids[index]} is missing or outside task scope`);
      }
      yield decodePrivateEntries(row);
    }
  }

  return {
    *loadControl(executionId): Operation<ExecutionControl | null> {
      const row = yield* call(() => selectControl(database, executionId));
      return row === undefined ? null : decodeControl(row);
    },
    *commitExecution(request): Operation<CommitExecutionResult> {
      return yield* transactions.immediate((transaction) =>
        commitExecution(transaction, request, faultInjection),
      );
    },
    *putObject(object): Operation<ExecutionObjectPointer> {
      return yield* transactions.immediate((transaction) => putObject(transaction, object));
    },
    *getObject(pointer): Operation<StoredExecutionObject | null> {
      const row = yield* call(() => selectObject(database, pointer.objectId));
      return row === undefined ? null : decodeObject(row);
    },
    *appendJournalSegment(segment): Operation<PrivateSegmentPointer> {
      return yield* transactions.immediate((transaction) =>
        putJournalSegment(transaction, segment),
      );
    },
    *appendReplaySegment(segment): Operation<PrivateSegmentPointer> {
      return yield* transactions.immediate((transaction) => putReplaySegment(transaction, segment));
    },
    *readJournal(task): Operation<AsyncIterable<readonly Json[]>> {
      return readPrivateChain("journal", task);
    },
    *readReplay(task): Operation<AsyncIterable<readonly Json[]>> {
      return readPrivateChain("replay", task);
    },
  };
}

export function createSqliteRepositories<
  TResultKind extends SQLiteResultKind,
  TRunResult,
>(options: {
  database: SweatpantsSqliteDatabase<TResultKind, TRunResult>;
  transactions: SqliteImmediateTransactions<SweatpantsSqliteDatabase<TResultKind, TRunResult>>;
  faultInjection?: (point: string) => void;
}): SqliteStorage {
  const database = options.database as SweatpantsSqliteDatabase<SQLiteResultKind, unknown>;
  const transactions = options.transactions as SqliteImmediateTransactions<
    SweatpantsSqliteDatabase<SQLiteResultKind, unknown>
  >;
  return {
    conversationStore: createConversationStore(database, transactions, options.faultInjection),
    executionStore: createExecutionStore(database, transactions, options.faultInjection),
  };
}
