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
import { type Json, canonicalDigest } from "@sweatpants/foundation";
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
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { call, sleep, type Operation } from "effection";
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
  type SqliteSchema,
} from "./schema.ts";

export type SQLiteResultKind = "sync" | "async";
export type SweatpantsSqliteDatabase<
  TResultKind extends SQLiteResultKind = SQLiteResultKind,
  TRunResult = unknown,
> = BaseSQLiteDatabase<TResultKind, TRunResult, SqliteSchema>;

type Database = SweatpantsSqliteDatabase<SQLiteResultKind, unknown>;
type HeadRow = typeof spConversationHeads.$inferSelect;
type ReceiptRow = typeof spConversationCommandReceipts.$inferSelect;
type CheckpointRow = typeof spConversationCheckpoints.$inferSelect;
type PublicRow = typeof spConversationPublicSegments.$inferSelect;
type PublicRootIndexRow = typeof spConversationPublicRootIndex.$inferSelect;
type TerminalRow = typeof spConversationTerminalSegments.$inferSelect;
type ControlRow = typeof spExecutionControl.$inferSelect;
type PrivateRow = typeof spExecutionJournalSegments.$inferSelect;
type ObjectRow = typeof spExecutionObjects.$inferSelect;

async function resolved<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

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

async function selectHead(
  database: Database,
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

async function selectTerminal(
  database: Database,
  segmentId: string,
): Promise<{ lastPosition: string } | undefined> {
  return await resolved(
    database
      .select({ lastPosition: spConversationTerminalSegments.lastPosition })
      .from(spConversationTerminalSegments)
      .where(eq(spConversationTerminalSegments.segmentId, segmentId))
      .get() as TerminalRow | undefined | Promise<{ lastPosition: string } | undefined>,
  );
}

async function loadHeadFromRow(database: Database, row: HeadRow): Promise<ConversationHead> {
  const terminal =
    row.terminalSegmentId === null ? null : await selectTerminal(database, row.terminalSegmentId);
  return headFromRow(row, terminal);
}

async function selectControl(
  database: Database,
  executionId: string,
): Promise<ControlRow | undefined> {
  return await resolved(
    database
      .select()
      .from(spExecutionControl)
      .where(eq(spExecutionControl.executionId, executionId))
      .get() as ControlRow | undefined | Promise<ControlRow | undefined>,
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
      const row = await resolved(
        database
          .select()
          .from(spConversationCommandReceipts)
          .where(
            and(
              eq(spConversationCommandReceipts.conversationId, conversationId!),
              eq(spConversationCommandReceipts.commandId, commandId!),
            ),
          )
          .get() as ReceiptRow | undefined | Promise<ReceiptRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const value = receiptFromRow(row);
      return immutableRecord(
        collection,
        conversationKeys.receipt(value.conversationId, value.commandId),
        value.commandDigest,
        encodeCommandReceipt(value),
      );
    }
    case DurableCollections.conversationCheckpoints: {
      const row = await resolved(
        (parts.length === 1
          ? database
              .select()
              .from(spConversationCheckpoints)
              .where(eq(spConversationCheckpoints.checkpointId, parts[0]!))
          : database
              .select()
              .from(spConversationCheckpoints)
              .where(
                and(
                  eq(spConversationCheckpoints.conversationId, parts[0]!),
                  eq(spConversationCheckpoints.causeKey, parts[1]!),
                ),
              )
        ).get() as CheckpointRow | undefined | Promise<CheckpointRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const value = checkpointFromRow(row);
      return immutableRecord(
        collection,
        conversationKeys.checkpoint(value.checkpointId),
        value.contentHash,
        encodeCheckpoint(value),
      );
    }
    case DurableCollections.conversationPublicSegments: {
      const row = await resolved(
        (parts.length === 1
          ? database
              .select()
              .from(spConversationPublicSegments)
              .where(eq(spConversationPublicSegments.segmentId, parts[0]!))
          : database
              .select()
              .from(spConversationPublicSegments)
              .where(
                and(
                  eq(spConversationPublicSegments.conversationId, parts[0]!),
                  eq(spConversationPublicSegments.minPosition, parts[1]!),
                  eq(spConversationPublicSegments.segmentId, parts[2]!),
                ),
              )
        ).get() as PublicRow | undefined | Promise<PublicRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const value = publicFromRow(row);
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
      const row = await resolved(
        database.select().from(spConversationPublicRootIndex).where(where).get() as
          | PublicRootIndexRow
          | undefined
          | Promise<PublicRootIndexRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const entry = publicRootIndexFromRow(row);
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
      const row = await resolved(
        database.select().from(spConversationTerminalSegments).where(where).get() as
          | TerminalRow
          | undefined
          | Promise<TerminalRow | undefined>,
      );
      if (!row) {
        return null;
      }
      const value = terminalFromRow(row);
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
      const row = await resolved(
        database.select().from(table).where(where).get() as
          | PrivateRow
          | undefined
          | Promise<PrivateRow | undefined>,
      );
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
      const row = await resolved(
        database
          .select()
          .from(spExecutionObjects)
          .where(eq(spExecutionObjects.objectId, objectId!))
          .get() as ObjectRow | undefined | Promise<ObjectRow | undefined>,
      );
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

async function insertImmutable(
  database: Database,
  record: { collection: ImmutableCollectionId; value: Uint8Array },
): Promise<void> {
  switch (record.collection) {
    case DurableCollections.conversationCommandReceipts: {
      const value = decodeCommandReceipt(record.value);
      await resolved(
        database.insert(spConversationCommandReceipts).values(receiptToRow(value)).run(),
      );
      return;
    }
    case DurableCollections.conversationCheckpoints: {
      const value = decodeCheckpoint(record.value);
      await resolved(
        database.insert(spConversationCheckpoints).values(checkpointToRow(value)).run(),
      );
      return;
    }
    case DurableCollections.conversationPublicSegments: {
      const value = decodePublicSegment(record.value);
      await resolved(
        database.insert(spConversationPublicSegments).values(publicToRow(value)).run(),
      );
      return;
    }
    case DurableCollections.conversationPublicRootIndex: {
      const value = decodeArchivedPublicRootIndex(record.value);
      await resolved(
        database.insert(spConversationPublicRootIndex).values(publicRootIndexToRow(value)).run(),
      );
      return;
    }
    case DurableCollections.conversationTerminalSegments: {
      const value = decodeTerminalSegment(record.value);
      await resolved(
        database.insert(spConversationTerminalSegments).values(terminalToRow(value)).run(),
      );
      return;
    }
    case DurableCollections.executionJournalSegments:
    case DurableCollections.executionReplaySegments: {
      // Mutation values come from the mandatory semantic codec, which already
      // checked hashes, ranges, byte counts, and entry bounds. The SQLite
      // binding only needs the canonical envelope fields for insertion.
      const value = await decodePrivateSegment(record.value);
      const table =
        record.collection === DurableCollections.executionJournalSegments
          ? spExecutionJournalSegments
          : spExecutionReplaySegments;
      await resolved(database.insert(table).values(privateToRow(value)).run());
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
          : await decodeExecutionObject(record.value);
      await resolved(database.insert(spExecutionObjects).values(objectToRow(value)).run());
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
  const row = controlToRow(value);
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
    const rows = await resolved(
      database
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
        )
        .all() as PrivateRow[] | Promise<PrivateRow[]>,
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
  const values = await Promise.all(
    ensures.map(async (ensure) => privateToRow(await decodePrivateSegment(ensure.value))),
  );
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

async function applyIn(
  database: Database,
  mutation: DurableMutation,
  faultInjection?: (point: string) => void,
): Promise<DurableMutationOutcome> {
  validateMutationStructure(mutation);
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
    await insertImmutable(database, mutation.claim);
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
      await insertImmutable(database, ensure);
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
  const metadataRows = await resolved(
    database
      .select({ id: idColumn, position: positionColumn, storedBytes: table.storedBytes })
      .from(table)
      .where(and(...conditions))
      .orderBy(request.direction === "forward" ? asc(positionColumn) : desc(positionColumn))
      .limit(request.maxRecords + 1)
      .all() as
      | { id: string; position: string; storedBytes: number }[]
      | Promise<{ id: string; position: string; storedBytes: number }[]>,
  );
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
  const rows = await resolved(
    database.select().from(table).where(where).all() as
      | Array<PublicRow | PublicRootIndexRow | TerminalRow | PrivateRow>
      | Promise<Array<PublicRow | PublicRootIndexRow | TerminalRow | PrivateRow>>,
  );
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

export function createSqliteDurableKernel<
  TResultKind extends SQLiteResultKind,
  TRunResult,
>(options: {
  database: SweatpantsSqliteDatabase<TResultKind, TRunResult>;
  transactionRunner: TransactionRunner<SweatpantsSqliteDatabase<TResultKind, TRunResult>>;
  faultInjection?: (point: string) => void;
}): DurableKernel {
  const database = options.database as Database;
  const transactionRunner = options.transactionRunner as TransactionRunner<Database>;
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
