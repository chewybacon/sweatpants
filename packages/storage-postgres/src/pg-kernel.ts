import {
  headFromRow,
  headToRow,
  receiptFromRow,
  checkpointFromRow,
  publicFromRow,
  publicRootIndexFromRow,
  terminalFromRow,
  receiptToRow,
  checkpointToRow,
  publicToRow,
  publicRootIndexToRow,
  terminalToRow,
} from "@sweatpants/history-store/sql-codec";
import {
  controlFromRow,
  controlToRow,
  privateEnvelopeFromRow,
  objectFromRow,
  privateToRow,
  objectToRow,
} from "@sweatpants/journal-authority/sql-codec";
import {
  DurableCollections,
  sqlNatural as numberValue,
  evaluateImmutableEnsure,
  evaluateMutation,
  evaluateMutationPreconditions,
  decodeDurableKey,
  decodeJsonValue,
  validateMutationStructure,
  validateScan,
  planScanPage,
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
import { type Json, canonicalDigest } from "@sweatpants/foundation";
import { call, sleep, type Operation } from "effection";
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
import type { ConversationHead } from "@sweatpants/history-store/contract";
import {
  decodeExecutionControl,
  decodeExecutionObject,
  decodePrivateSegment,
  encodeExecutionControl,
  encodeExecutionObjectEnvelope,
  executionKeys,
} from "@sweatpants/journal-authority/store-persistence";
import type { StoredExecutionObject } from "@sweatpants/journal-authority/store";
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
  type ExecutionControlRow,
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
type PublicRow = PublicSegmentRow;
type TerminalRow = TerminalSegmentRow;
type ControlRow = ExecutionControlRow;
type PrivateRow = JournalSegmentRow;

function invalid(message: string): never {
  throw new DurableKernelError("durable_kernel_persisted_data_invalid", message);
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

async function selectTerminal(
  database: Database,
  segmentId: string,
): Promise<{ lastPosition: string } | null> {
  const rows = await database
    .select({ lastPosition: spConversationTerminalSegments.lastPosition })
    .from(spConversationTerminalSegments)
    .where(eq(spConversationTerminalSegments.segmentId, segmentId))
    .limit(1);
  return rows[0] ?? null;
}

async function loadHeadFromRow(database: Database, row: HeadRow): Promise<ConversationHead> {
  const terminal =
    row.terminalSegmentId === null ? null : await selectTerminal(database, row.terminalSegmentId);
  return headFromRow(row, terminal);
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
    const head = await loadHeadFromRow(database, row);
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
        canonicalDigest(entry),
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
        .values(receiptToRow(value))
        .onConflictDoNothing()
        .returning({ commandId: spConversationCommandReceipts.commandId });
      return inserted.length > 0;
    }
    case DurableCollections.conversationCheckpoints: {
      const value = decodeCheckpoint(record.value);
      const inserted = await database
        .insert(spConversationCheckpoints)
        .values(checkpointToRow(value))
        .onConflictDoNothing()
        .returning({ checkpointId: spConversationCheckpoints.checkpointId });
      return inserted.length > 0;
    }
    case DurableCollections.conversationPublicSegments: {
      const value = decodePublicSegment(record.value);
      const inserted = await database
        .insert(spConversationPublicSegments)
        .values(publicToRow(value))
        .onConflictDoNothing()
        .returning({ segmentId: spConversationPublicSegments.segmentId });
      return inserted.length > 0;
    }
    case DurableCollections.conversationPublicRootIndex: {
      const value = decodeArchivedPublicRootIndex(record.value);
      const inserted = await database
        .insert(spConversationPublicRootIndex)
        .values(publicRootIndexToRow(value))
        .onConflictDoNothing()
        .returning({ position: spConversationPublicRootIndex.position });
      return inserted.length > 0;
    }
    case DurableCollections.conversationTerminalSegments: {
      const value = decodeTerminalSegment(record.value);
      const inserted = await database
        .insert(spConversationTerminalSegments)
        .values(terminalToRow(value))
        .onConflictDoNothing()
        .returning({ segmentId: spConversationTerminalSegments.segmentId });
      return inserted.length > 0;
    }
    case DurableCollections.executionJournalSegments:
    case DurableCollections.executionReplaySegments: {
      const value = await decodePrivateSegment(record.value);
      const table =
        record.collection === DurableCollections.executionJournalSegments
          ? spExecutionJournalSegments
          : spExecutionReplaySegments;
      const inserted = await database
        .insert(table)
        .values(privateToRow(value))
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
          : await decodeExecutionObject(record.value);
      const inserted = await database
        .insert(spExecutionObjects)
        .values(objectToRow(value))
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
    const row = headToRow(value);
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
  const row = controlToRow(value);
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
    const selected = ensures.filter(
      (ensure) => ensure.collection === collection && ensure.alternateKeys?.length === 1,
    );
    if (selected.length < 4) {
      continue;
    }
    const ranges = selected.map((ensure) => requireKey(ensure.alternateKeys?.[0] ?? "", [4]));
    const segmentIds = selected.map((ensure) => requireKey(ensure.key, [1])[0]!);
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
          ...ranges.map(([executionId, taskId, firstSequence, lastSequence]) =>
            and(
              eq(table.executionId, executionId!),
              eq(table.taskId, taskId!),
              eq(table.firstSequence, firstSequence!),
              eq(table.lastSequence, lastSequence!),
            ),
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

// Throwing rolls back every staged write before the kernel replans against the winner.
class RetryImmutableInsert extends Error {}

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
  const values = await Promise.all(
    ensures.map(async (ensure) => privateToRow(await decodePrivateSegment(ensure.value))),
  );
  const inserted = await database
    .insert(table)
    .values(values)
    .onConflictDoNothing()
    .returning({ segmentId: table.segmentId });
  if (inserted.length !== ensures.length) {
    throw new RetryImmutableInsert();
  }
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
  const claim = mutation.claim
    ? await readImmutableIn(database, mutation.claim.collection, mutation.claim.key)
    : null;
  const current =
    !claim && mutation.authority
      ? await readAuthorityIn(database, mutation.authority.collection, mutation.authority.key)
      : null;
  const preconditions = { claim, authority: current };
  const preconditionConflict = evaluateMutationPreconditions(mutation, preconditions);
  if (preconditionConflict) {
    return preconditionConflict;
  }

  const candidates = new Map(await prefetchPrivateCandidates(database, mutation.ensures));
  for (const ensure of mutation.ensures) {
    if (!candidates.has(ensure.name)) {
      candidates.set(ensure.name, await readEnsureCandidates(database, ensure));
    }
    const conflict = evaluateImmutableEnsure(mutation, ensure, candidates.get(ensure.name)!);
    if (conflict) {
      return conflict;
    }
  }
  const plan = evaluateMutation(mutation, {
    ...preconditions,
    candidates: (ensure) => candidates.get(ensure.name)!,
  });
  if (plan.status !== "ready") {
    return plan;
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
  const missing = plan.inserts;
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
      if (!(await insertImmutable(database, ensure))) {
        throw new RetryImmutableInsert();
      }
    }
  }
  if (
    mutation.authority?.collection === DurableCollections.executionControls &&
    mutation.ensures.length > 0
  ) {
    faultInjection?.("execution-after-segment-insert");
  }
  const authority = plan.outcome.authority;
  if (authority) {
    await replaceAuthority(database, authority, current);
    if (authority.collection === DurableCollections.conversationHeads && mutation.claim) {
      faultInjection?.("command-before-commit");
    }
    if (authority.collection === DurableCollections.executionControls) {
      faultInjection?.("execution-before-commit");
    }
  }
  return plan.outcome;
}

async function scanIn(database: Database, request: BoundedScan): Promise<StoredScanPage> {
  validateScan(request);
  const scope = decodeDurableKey(request.scope);
  const rootIndex = request.collection === DurableCollections.conversationPublicRootIndex;
  const table = rootIndex
    ? spConversationPublicRootIndex
    : request.collection === DurableCollections.conversationPublicSegments
      ? spConversationPublicSegments
      : request.collection === DurableCollections.conversationTerminalSegments
        ? spConversationTerminalSegments
        : request.collection === DurableCollections.executionJournalSegments
          ? spExecutionJournalSegments
          : spExecutionReplaySegments;
  const positionColumn =
    "position" in table
      ? table.position
      : "minPosition" in table
        ? table.minPosition
        : "firstPosition" in table
          ? table.firstPosition
          : table.firstSequence;
  const idColumn = rootIndex ? spConversationPublicRootIndex.position : table.segmentId;
  const conditions: SQL[] =
    "conversationId" in table
      ? [eq(table.conversationId, scope[0]!)]
      : [eq(table.executionId, scope[0]!), eq(table.taskId, scope[1]!)];
  if (request.after !== null) {
    conditions.push(
      request.direction === "forward"
        ? gt(positionColumn, request.after)
        : lt(positionColumn, request.after),
    );
  }
  if (request.through !== undefined) {
    conditions.push(
      request.direction === "forward"
        ? lte(positionColumn, request.through)
        : gte(positionColumn, request.through),
    );
  }
  const metadataRows = await database
    .select({ id: idColumn, position: positionColumn, storedBytes: table.storedBytes })
    .from(table)
    .where(and(...conditions))
    .orderBy(request.direction === "forward" ? asc(positionColumn) : desc(positionColumn))
    .limit(request.maxRecords + 1);
  const page = planScanPage(
    request,
    metadataRows.map((row) => ({
      key: row.id,
      position: row.position,
      storedBytes: numberValue(row.storedBytes, "stored_bytes"),
    })),
  );
  if (page.selected.length === 0) {
    return { records: [], nextCursor: page.nextCursor };
  }
  // Immutable rows cannot change between the metadata seek and this bounded payload read.
  // The root index has a composite identity, so retain its conversation scope.
  const selected = inArray(
    idColumn,
    page.selected.map((row) => row.key),
  );
  const where = rootIndex
    ? and(eq(spConversationPublicRootIndex.conversationId, scope[0]!), selected)
    : selected;
  const rows = await database.select().from(table).where(where);
  const byKey = new Map(rows.map((row) => ["position" in row ? row.position : row.segmentId, row]));
  const records = page.selected.map((metadata) => {
    const row = byKey.get(metadata.key);
    if (!row) {
      return invalid("Missing indexed journal record");
    }
    const record =
      request.collection === DurableCollections.conversationPublicRootIndex
        ? (() => {
            const entry = publicRootIndexFromRow(row as PublicRootIndexRow);
            return immutableRecord(
              request.collection,
              conversationKeys.publicRootIndex(entry.conversationId, entry.position),
              canonicalDigest(entry),
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
    if (record.value.byteLength !== metadata.storedBytes) {
      return invalid("Indexed record byte count disagrees with payload");
    }
    return { ...record, position: metadata.position, storedBytes: metadata.storedBytes };
  });
  return { records, nextCursor: page.nextCursor };
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
      // Each lost insert makes at least one immutable identity visible on the next snapshot.
      // Bound retries by the mutation size so malformed payload identities cannot spin forever.
      for (let attempt = 0; attempt <= mutation.ensures.length; attempt++) {
        try {
          return yield* transactionRunner.transaction((transaction) =>
            applyIn(transaction, mutation, options.faultInjection),
          );
        } catch (error) {
          if (!(error instanceof RetryImmutableInsert)) {
            throw error;
          }
          options.faultInjection?.("ensure-insert-race-retry");
        }
      }
      return invalid("Immutable insert identities did not stabilize");
    },
  };
}
