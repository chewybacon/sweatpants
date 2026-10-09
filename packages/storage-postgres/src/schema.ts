import {
  bigint,
  check,
  customType,
  index,
  integer,
  primaryKey,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { Json } from "@sweatpants/foundation";
import { sqlCounter } from "@sweatpants/durable-storage-kernel";

/**
 * String-encoded, arbitrary-precision decimal counter constrained to the
 * backend integer range. The guard is deliberately identical to the SQLite
 * binding: the kernel contract treats counter overflow as backend-neutral.
 */
export const durableCounter = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return "bigint";
  },
  toDriver(value) {
    return sqlCounter(value).toString(10);
  },
  fromDriver(value) {
    return sqlCounter(value).toString(10);
  },
});

// node-postgres already decodes JSONB. Drizzle's built-in JSONB column tries
// to parse string values again, corrupting JSON strings containing JSON text.
const jsonb = customType<{ data: Json; driverData: unknown }>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value as Json;
  },
});

/** Epoch-millisecond timestamps; bigint because PG INTEGER is 32-bit. */
export const epochMillis = (name: string) => bigint(name, { mode: "number" });

// Drizzle represents a top-level JSON null as SQL NULL. Scalar JSON columns
// therefore allow NULL; JSON arrays remain NOT NULL. Row mapping preserves null.
export const spConversationHeads = pgTable(
  "sp_conversation_heads",
  {
    conversationId: text("conversation_id").primaryKey().notNull(),
    revision: durableCounter("revision").notNull(),
    ownerEpoch: durableCounter("owner_epoch").notNull(),
    ownerRouteJson: jsonb("owner_route_json").$type<Json>(),
    state: text("state").notNull(),
    checkpointId: text("checkpoint_id"),
    terminalSegmentId: text("terminal_segment_id"),
    activeLogicalTurnId: text("active_logical_turn_id"),
    activeExecutionId: text("active_execution_id"),
    latestCompletedExecutionId: text("latest_completed_execution_id"),
    activeSegmentJson: jsonb("active_segment_json").$type<Json>(),
    activeCommandJson: jsonb("active_command_json").$type<Json>(),
    deletedAt: epochMillis("deleted_at"),
    updatedAt: epochMillis("updated_at").notNull(),
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

export const spConversationCheckpoints = pgTable(
  "sp_conversation_checkpoints",
  {
    checkpointId: text("checkpoint_id").primaryKey().notNull(),
    conversationId: text("conversation_id").notNull(),
    causeKey: text("cause_key").notNull(),
    causeJson: jsonb("cause_json").$type<Json>(),
    contentHash: text("content_hash").notNull(),
    lineageId: text("lineage_id").notNull(),
    archiveHeadSegmentId: text("archive_head_segment_id"),
    archiveFrontierOrdinal: durableCounter("archive_frontier_ordinal").notNull(),
    nextPublicPosition: durableCounter("next_public_position").notNull(),
    payloadJson: jsonb("payload_json").$type<Json>(),
    encodedBytes: integer("encoded_bytes").notNull(),
    createdAt: epochMillis("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("sp_checkpoint_conversation_cause").on(table.conversationId, table.causeKey),
    index("sp_checkpoint_conversation_created").on(table.conversationId, table.createdAt),
    check("sp_checkpoint_archive_frontier", sql`${table.archiveFrontierOrdinal} >= 0`),
    check("sp_checkpoint_next_public_position", sql`${table.nextPublicPosition} >= 0`),
    check("sp_checkpoint_encoded_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spConversationPublicSegments = pgTable(
  "sp_conversation_public_segments",
  {
    segmentId: text("segment_id").primaryKey().notNull(),
    conversationId: text("conversation_id").notNull(),
    previousSegmentId: text("previous_segment_id"),
    minPosition: durableCounter("min_position").notNull(),
    maxPosition: durableCounter("max_position").notNull(),
    rootsJson: jsonb("roots_json").$type<readonly Json[]>().notNull(),

    contentHash: text("content_hash").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
    createdAt: epochMillis("created_at").notNull(),
  },
  (table) => [
    index("sp_public_segment_conversation_position").on(
      table.conversationId,
      table.minPosition,
      table.maxPosition,
    ),
    check("sp_public_segment_min_position", sql`${table.minPosition} >= 0`),
    check("sp_public_segment_positions", sql`${table.maxPosition} >= ${table.minPosition}`),
    check("sp_public_segment_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spConversationPublicRootIndex = pgTable(
  "sp_conversation_public_root_index",
  {
    conversationId: text("conversation_id").notNull(),
    position: durableCounter("position").notNull(),
    rootId: text("root_id").notNull(),
    segmentId: text("segment_id").notNull(),
    segmentRootIndex: integer("segment_root_index").notNull(),
    archiveOrdinal: durableCounter("archive_ordinal").notNull(),

    contentHash: text("content_hash").notNull(),
    encodedBytes: integer("encoded_bytes").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.position] }),
    uniqueIndex("sp_public_root_identity").on(table.conversationId, table.rootId),
    uniqueIndex("sp_public_root_archive_ordinal").on(table.conversationId, table.archiveOrdinal),
    index("sp_public_root_segment").on(table.segmentId, table.segmentRootIndex),
    check("sp_public_root_position", sql`${table.position} >= 0`),
    check("sp_public_root_segment_index", sql`${table.segmentRootIndex} >= 0`),
    check("sp_public_root_archive_ordinal_check", sql`${table.archiveOrdinal} >= 0`),
    check("sp_public_root_bytes", sql`${table.encodedBytes} >= 0`),
  ],
);

export const spConversationTerminalSegments = pgTable(
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
    entriesJson: jsonb("entries_json").$type<readonly Json[]>().notNull(),

    contentHash: text("content_hash").notNull(),
    createdAt: epochMillis("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("sp_terminal_segment_publication").on(table.conversationId, table.publicationKey),
    index("sp_terminal_segment_conversation_position").on(
      table.conversationId,
      table.firstPosition,
      table.lastPosition,
    ),
    // JSONB may expand numeric notation; bound the representation scans actually return.
    check(
      "sp_terminal_segment_payload_limit",
      sql`octet_length(${table.entriesJson}::text) <= 16777216`,
    ),
    check("sp_terminal_segment_first_position", sql`${table.firstPosition} >= 0`),
    check("sp_terminal_segment_positions", sql`${table.lastPosition} >= ${table.firstPosition}`),
  ],
);

export const spConversationCommandReceipts = pgTable(
  "sp_conversation_command_receipts",
  {
    conversationId: text("conversation_id").notNull(),
    commandId: text("command_id").notNull(),
    commandDigest: text("command_digest").notNull(),
    participantId: text("participant_id").notNull(),
    acceptedAt: epochMillis("accepted_at").notNull(),
    retainUntil: epochMillis("retain_until").notNull(),
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

export const spExecutionControl = pgTable(
  "sp_execution_control",
  {
    executionId: text("execution_id").primaryKey().notNull(),
    controlRevision: durableCounter("control_revision").notNull(),
    ownerFence: durableCounter("owner_fence").notNull(),
    status: text("status").notNull(),
    rootTaskId: text("root_task_id").notNull(),
    stopGeneration: durableCounter("stop_generation").notNull(),
    requestedDisposition: text("requested_disposition"),
    controlJson: jsonb("control_json").$type<Json>(),
    updatedAt: epochMillis("updated_at").notNull(),
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
  entriesJson: jsonb("entries_json").$type<readonly Json[]>().notNull(),

  contentHash: text("content_hash").notNull(),
  encodedBytes: integer("encoded_bytes").notNull(),
  createdAt: epochMillis("created_at").notNull(),
} as const;

export const spExecutionJournalSegments = pgTable(
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

export const spExecutionReplaySegments = pgTable(
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

export const spExecutionObjects = pgTable(
  "sp_execution_objects",
  {
    objectId: text("object_id").primaryKey().notNull(),
    lifetimeScope: text("lifetime_scope").notNull(),
    scopeOwnerId: text("scope_owner_id").notNull(),
    objectKind: text("object_kind").notNull(),
    contentHash: text("content_hash").notNull(),
    byteLength: integer("byte_length").notNull(),
    jsonBody: jsonb("json_body").$type<Json>(),
    createdAt: epochMillis("created_at").notNull(),
  },
  (table) => [
    check(
      "sp_execution_object_scope",
      sql`${table.lifetimeScope} IN ('execution', 'conversation')`,
    ),
    check("sp_execution_object_bytes", sql`${table.byteLength} >= 0`),
    index("sp_execution_object_scope_index").on(
      table.lifetimeScope,
      table.scopeOwnerId,
      table.objectKind,
    ),
    index("sp_execution_object_created").on(table.createdAt),
  ],
);

export const postgresSchema = {
  spConversationHeads,
  spConversationCheckpoints,
  spConversationPublicSegments,
  spConversationPublicRootIndex,
  spConversationTerminalSegments,
  spConversationCommandReceipts,
  spExecutionControl,
  spExecutionJournalSegments,
  spExecutionReplaySegments,
  spExecutionObjects,
};

export type PostgresSchema = typeof postgresSchema;
export type ConversationHeadRow = typeof spConversationHeads.$inferSelect;
export type CheckpointRow = typeof spConversationCheckpoints.$inferSelect;
export type PublicSegmentRow = typeof spConversationPublicSegments.$inferSelect;
export type PublicRootIndexRow = typeof spConversationPublicRootIndex.$inferSelect;
export type TerminalSegmentRow = typeof spConversationTerminalSegments.$inferSelect;
export type CommandReceiptRow = typeof spConversationCommandReceipts.$inferSelect;
export type ExecutionControlRow = typeof spExecutionControl.$inferSelect;
export type JournalSegmentRow = typeof spExecutionJournalSegments.$inferSelect;
export type ReplaySegmentRow = typeof spExecutionReplaySegments.$inferSelect;
export type ExecutionObjectRow = typeof spExecutionObjects.$inferSelect;
