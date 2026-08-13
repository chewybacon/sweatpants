import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { StorageError } from "./contract.ts";

export const durableCounter = customType<{
  data: string;
  driverData: bigint | number;
}>({
  dataType() {
    return "integer";
  },
  toDriver(value) {
    if (!/^\d+$/.test(value)) {
      throw new StorageError("sqlite_integer_out_of_range", `Invalid durable counter: ${value}`);
    }
    const parsed = BigInt(value);
    if (parsed > 9_223_372_036_854_775_807n) {
      throw new StorageError(
        "sqlite_integer_out_of_range",
        `Durable counter is outside SQLite INTEGER range: ${value}`,
      );
    }
    return parsed;
  },
  fromDriver(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new StorageError(
        "sqlite_integer_out_of_range",
        `Unsafe durable counter returned by SQLite driver: ${value}`,
      );
    }
    const parsed = typeof value === "bigint" ? value : BigInt(value);
    if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) {
      throw new StorageError(
        "sqlite_integer_out_of_range",
        `Durable counter is outside SQLite INTEGER range: ${parsed}`,
      );
    }
    return parsed.toString(10);
  },
});

export const binaryBody = customType<{
  data: Uint8Array;
  driverData: Uint8Array;
}>({
  dataType() {
    return "blob";
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return new Uint8Array(value);
  },
});

export const spConversationHeads = sqliteTable(
  "sp_conversation_heads",
  {
    conversationId: text("conversation_id").primaryKey().notNull(),
    revision: durableCounter("revision").notNull(),
    ownerEpoch: durableCounter("owner_epoch").notNull(),
    ownerRouteJson: text("owner_route_json"),
    state: text("state").notNull(),
    checkpointId: text("checkpoint_id"),
    terminalSegmentId: text("terminal_segment_id"),
    activeLogicalTurnId: text("active_logical_turn_id"),
    activeExecutionId: text("active_execution_id"),
    latestCompletedExecutionId: text("latest_completed_execution_id"),
    activeSegmentJson: text("active_segment_json"),
    activeCommandJson: text("active_command_json"),
    deletedAt: integer("deleted_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("sp_heads_revision", sql`${table.revision} >= 0`),
    check("sp_heads_owner_epoch", sql`${table.ownerEpoch} >= 0`),
    check(
      "sp_heads_state",
      sql`${table.state} IN ('idle', 'running', 'parked', 'recovering', 'deleted')`,
    ),
    check(
      "sp_heads_deleted_state",
      sql`(${table.state} = 'deleted') = (${table.deletedAt} IS NOT NULL)`,
    ),
    check(
      "sp_heads_deleted_tombstone",
      sql`${table.state} <> 'deleted' OR (
        ${table.checkpointId} IS NULL AND ${table.terminalSegmentId} IS NULL AND
        ${table.activeLogicalTurnId} IS NULL AND ${table.activeExecutionId} IS NULL AND
        ${table.latestCompletedExecutionId} IS NULL AND ${table.activeSegmentJson} IS NULL AND
        ${table.activeCommandJson} IS NULL AND ${table.ownerRouteJson} IS NULL
      )`,
    ),
  ],
);

export const spConversationCheckpoints = sqliteTable(
  "sp_conversation_checkpoints",
  {
    checkpointId: text("checkpoint_id").primaryKey().notNull(),
    conversationId: text("conversation_id").notNull(),
    causeKey: text("cause_key").notNull(),
    causeJson: text("cause_json").notNull(),
    contentHash: text("content_hash").notNull(),
    archiveHeadSegmentId: text("archive_head_segment_id"),
    archiveThroughPosition: durableCounter("archive_through_position").notNull(),
    payloadJson: text("payload_json").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("sp_checkpoint_conversation_cause").on(table.conversationId, table.causeKey),
    index("sp_checkpoint_conversation_created").on(table.conversationId, table.createdAt),
    check("sp_checkpoint_archive_position", sql`${table.archiveThroughPosition} >= 0`),
    check("sp_checkpoint_encoded_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spConversationPublicSegments = sqliteTable(
  "sp_conversation_public_segments",
  {
    segmentId: text("segment_id").primaryKey().notNull(),
    conversationId: text("conversation_id").notNull(),
    previousSegmentId: text("previous_segment_id"),
    firstPosition: durableCounter("first_position").notNull(),
    lastPosition: durableCounter("last_position").notNull(),
    rootsJson: text("roots_json").notNull(),
    contentHash: text("content_hash").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("sp_public_segment_conversation_position").on(
      table.conversationId,
      table.firstPosition,
      table.lastPosition,
    ),
    check("sp_public_segment_first_position", sql`${table.firstPosition} >= 0`),
    check("sp_public_segment_positions", sql`${table.lastPosition} >= ${table.firstPosition}`),
    check("sp_public_segment_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spConversationTerminalSegments = sqliteTable(
  "sp_conversation_terminal_segments",
  {
    segmentId: text("segment_id").primaryKey().notNull(),
    conversationId: text("conversation_id").notNull(),
    logicalTurnId: text("logical_turn_id").notNull(),
    executionId: text("execution_id").notNull(),
    publicationKey: text("publication_key").notNull(),
    previousSegmentId: text("previous_segment_id"),
    firstPosition: durableCounter("first_position").notNull(),
    lastPosition: durableCounter("last_position").notNull(),
    entriesJson: text("entries_json").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("sp_terminal_segment_publication").on(table.conversationId, table.publicationKey),
    index("sp_terminal_segment_conversation_position").on(
      table.conversationId,
      table.firstPosition,
      table.lastPosition,
    ),
    check("sp_terminal_segment_first_position", sql`${table.firstPosition} >= 0`),
    check("sp_terminal_segment_positions", sql`${table.lastPosition} >= ${table.firstPosition}`),
  ],
);

export const spConversationCommandReceipts = sqliteTable(
  "sp_conversation_command_receipts",
  {
    conversationId: text("conversation_id").notNull(),
    commandId: text("command_id").notNull(),
    commandDigest: text("command_digest").notNull(),
    participantId: text("participant_id").notNull(),
    acceptedAt: integer("accepted_at").notNull(),
    retainUntil: integer("retain_until").notNull(),
    admittedRevision: durableCounter("admitted_revision").notNull(),
    resultingRevision: durableCounter("resulting_revision").notNull(),
    logicalTurnId: text("logical_turn_id"),
    executionId: text("execution_id"),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.commandId] }),
    check("sp_receipt_admitted_revision", sql`${table.admittedRevision} >= 0`),
    check(
      "sp_receipt_resulting_revision",
      sql`${table.resultingRevision} > ${table.admittedRevision}`,
    ),
    index("sp_receipt_retain_until").on(table.retainUntil),
  ],
);

export const spExecutionControl = sqliteTable(
  "sp_execution_control",
  {
    executionId: text("execution_id").primaryKey().notNull(),
    controlRevision: durableCounter("control_revision").notNull(),
    ownerFence: durableCounter("owner_fence").notNull(),
    status: text("status").notNull(),
    rootTaskId: text("root_task_id").notNull(),
    stopGeneration: durableCounter("stop_generation").notNull(),
    requestedDisposition: text("requested_disposition"),
    controlJson: text("control_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check(
      "sp_execution_control_status",
      sql`${table.status} IN ('active', 'parked', 'cancelling', 'terminal')`,
    ),
    check(
      "sp_execution_control_disposition",
      sql`${table.requestedDisposition} IS NULL OR ${table.requestedDisposition} IN ('cancelled', 'superseded')`,
    ),
    check("sp_execution_control_revision", sql`${table.controlRevision} >= 0`),
    check("sp_execution_control_owner_fence", sql`${table.ownerFence} >= 0`),
    check("sp_execution_control_stop_generation", sql`${table.stopGeneration} >= 0`),
  ],
);

const privateSegmentColumns = {
  segmentId: text("segment_id").primaryKey().notNull(),
  executionId: text("execution_id").notNull(),
  taskId: text("task_id").notNull(),
  previousSegmentId: text("previous_segment_id"),
  firstSequence: durableCounter("first_sequence").notNull(),
  lastSequence: durableCounter("last_sequence").notNull(),
  entriesJson: text("entries_json").notNull(),
  contentHash: text("content_hash").notNull(),
  encodedBytes: integer("encoded_bytes").notNull(),
  createdAt: integer("created_at").notNull(),
} as const;

export const spExecutionJournalSegments = sqliteTable(
  "sp_execution_journal_segments",
  privateSegmentColumns,
  (table) => [
    uniqueIndex("sp_journal_task_range").on(
      table.executionId,
      table.taskId,
      table.firstSequence,
      table.lastSequence,
    ),
    index("sp_journal_task_sequence").on(table.executionId, table.taskId, table.firstSequence),
    check("sp_journal_segment_first_sequence", sql`${table.firstSequence} >= 0`),
    check("sp_journal_segment_positions", sql`${table.lastSequence} >= ${table.firstSequence}`),
    check("sp_journal_segment_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spExecutionReplaySegments = sqliteTable(
  "sp_execution_replay_segments",
  privateSegmentColumns,
  (table) => [
    uniqueIndex("sp_replay_task_range").on(
      table.executionId,
      table.taskId,
      table.firstSequence,
      table.lastSequence,
    ),
    index("sp_replay_task_sequence").on(table.executionId, table.taskId, table.firstSequence),
    check("sp_replay_segment_first_sequence", sql`${table.firstSequence} >= 0`),
    check("sp_replay_segment_positions", sql`${table.lastSequence} >= ${table.firstSequence}`),
    check("sp_replay_segment_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spExecutionObjects = sqliteTable(
  "sp_execution_objects",
  {
    objectId: text("object_id").primaryKey().notNull(),
    lifetimeScope: text("lifetime_scope").notNull(),
    scopeOwnerId: text("scope_owner_id").notNull(),
    objectKind: text("object_kind").notNull(),
    contentHash: text("content_hash").notNull(),
    byteLength: integer("byte_length").notNull(),
    jsonBody: text("json_body"),
    blobBody: binaryBody("blob_body"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "sp_execution_object_scope",
      sql`${table.lifetimeScope} IN ('execution', 'conversation')`,
    ),
    check("sp_execution_object_bytes", sql`${table.byteLength} >= 0`),
    check(
      "sp_execution_object_one_body",
      sql`(${table.jsonBody} IS NULL) <> (${table.blobBody} IS NULL)`,
    ),
    index("sp_execution_object_scope_index").on(
      table.lifetimeScope,
      table.scopeOwnerId,
      table.objectKind,
    ),
    index("sp_execution_object_created").on(table.createdAt),
  ],
);

export const sqliteSchema = {
  spConversationHeads,
  spConversationCheckpoints,
  spConversationPublicSegments,
  spConversationTerminalSegments,
  spConversationCommandReceipts,
  spExecutionControl,
  spExecutionJournalSegments,
  spExecutionReplaySegments,
  spExecutionObjects,
};

export type SqliteSchema = typeof sqliteSchema;
export type ConversationHeadRow = typeof spConversationHeads.$inferSelect;
export type CheckpointRow = typeof spConversationCheckpoints.$inferSelect;
export type PublicSegmentRow = typeof spConversationPublicSegments.$inferSelect;
export type TerminalSegmentRow = typeof spConversationTerminalSegments.$inferSelect;
export type CommandReceiptRow = typeof spConversationCommandReceipts.$inferSelect;
export type ExecutionControlRow = typeof spExecutionControl.$inferSelect;
export type JournalSegmentRow = typeof spExecutionJournalSegments.$inferSelect;
export type ReplaySegmentRow = typeof spExecutionReplaySegments.$inferSelect;
export type ExecutionObjectRow = typeof spExecutionObjects.$inferSelect;
