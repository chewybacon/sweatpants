import {
  sqlNatural as numberValue,
  encodeJsonValue,
  type SqlNumbers,
  invalidStoredSqlValue as invalid,
  priorSqlPosition as priorPosition,
} from "@sweatpants/durable-storage-kernel";
import { canonicalJson, parseJsonText, type Json } from "@sweatpants/foundation";
import type {
  ArchivedPublicRootIndex,
  CommandReceipt,
  ConversationHead,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
} from "./contract.ts";
import { decodeConversationHead, encodeConversationHead } from "./persistence.ts";
type HeadRow = SqlNumbers<
  Omit<
    ConversationHead,
    "ownerRoute" | "state" | "checkpoint" | "terminalHistory" | "activeSegment" | "activeCommand"
  >
> & {
  ownerRouteJson: string | null;
  state: string;
  checkpointId: string | null;
  terminalSegmentId: string | null;
  activeSegmentJson: string | null;
  activeCommandJson: string | null;
};
type ReceiptRow = SqlNumbers<Omit<CommandReceipt, "logicalTurnId" | "executionId">> & {
  logicalTurnId: string | null;
  executionId: string | null;
};
type CheckpointRow = SqlNumbers<Omit<StoredCheckpoint, "cause" | "archiveHead" | "payload">> & {
  causeJson: string;
  archiveHeadSegmentId: string | null;
  payloadJson: string;
};
type PublicRow = SqlNumbers<Omit<StoredPublicArchiveSegment, "previous" | "roots">> & {
  previousSegmentId: string | null;
  rootsJson: string;
};
type PublicRootIndexRow = SqlNumbers<ArchivedPublicRootIndex>;
type TerminalRow = SqlNumbers<Omit<StoredTerminalSegment, "previous" | "entries">> & {
  previousSegmentId: string | null;
  entriesJson: string;
};
function nullableJson(value: string | null, field: string): Json | null {
  return value === null ? null : parseJsonText(value, field);
}
export function headFromRow(
  row: HeadRow,
  terminal: { lastPosition: string } | null | undefined,
): ConversationHead {
  if (row.terminalSegmentId !== null && terminal == null) {
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
export function receiptFromRow(row: ReceiptRow): CommandReceipt {
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
export function checkpointFromRow(row: CheckpointRow): StoredCheckpoint {
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
export function publicFromRow(row: PublicRow): StoredPublicArchiveSegment {
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
export function publicRootIndexFromRow(row: PublicRootIndexRow): ArchivedPublicRootIndex {
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
export function terminalFromRow(row: TerminalRow): StoredTerminalSegment {
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
export function receiptToRow(value: CommandReceipt) {
  return {
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
  };
}
export function checkpointToRow(value: StoredCheckpoint) {
  return {
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
  };
}
export function publicToRow(value: StoredPublicArchiveSegment) {
  return {
    segmentId: value.segmentId,
    conversationId: value.conversationId,
    previousSegmentId: value.previous?.segmentId ?? null,
    minPosition: value.minPosition,
    maxPosition: value.maxPosition,
    rootsJson: canonicalJson(value.roots),
    contentHash: value.contentHash,
    encodedBytes: value.encodedBytes,
    createdAt: value.createdAt,
    storedBytes:
      encodeJsonValue({ ...value, roots: [] } as unknown as Json).byteLength -
      2 +
      value.encodedBytes,
  };
}
export function publicRootIndexToRow(value: ArchivedPublicRootIndex) {
  return {
    conversationId: value.conversationId,
    position: value.position,
    rootId: value.rootId,
    segmentId: value.segmentId,
    segmentRootIndex: value.segmentRootIndex,
    archiveOrdinal: value.archiveOrdinal,
    contentHash: value.contentHash,
    encodedBytes: value.encodedBytes,
    storedBytes: encodeJsonValue(value as unknown as Json).byteLength,
  };
}
export function terminalToRow(value: StoredTerminalSegment) {
  const entriesJson = canonicalJson(value.entries);
  return {
    segmentId: value.segmentId,
    conversationId: value.conversationId,
    logicalTurnId: value.logicalTurnId,
    executionId: value.executionId,
    publicationKey: value.publicationKey,
    previousSegmentId: value.previous?.segmentId ?? null,
    firstPosition: value.firstPosition,
    lastPosition: value.lastPosition,
    entriesJson,
    contentHash: value.contentHash,
    createdAt: value.createdAt,
    storedBytes:
      encodeJsonValue({ ...value, entries: [] } as unknown as Json).byteLength -
      2 +
      new TextEncoder().encode(entriesJson).byteLength,
  };
}

export function headToRow(value: ConversationHead) {
  return {
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
}
