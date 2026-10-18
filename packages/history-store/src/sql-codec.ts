import {
  sqlNatural as numberValue,
  type SqlNumbers,
  invalidStoredSqlValue as invalid,
  priorSqlPosition as priorPosition,
} from "@sweatpants/durable-storage-kernel";
import type { Json } from "@sweatpants/foundation";
import type {
  ArchivedPublicRootIndex,
  CommandReceipt,
  ConversationHead,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
} from "./contract.ts";
import { readConversationHead } from "./persistence.ts";
type HeadRow = SqlNumbers<
  Omit<
    ConversationHead,
    "ownerRoute" | "state" | "checkpoint" | "terminalHistory" | "activeSegment" | "activeCommand"
  >
> & {
  ownerRouteJson: Json | null;
  state: string;
  checkpointId: string | null;
  terminalSegmentId: string | null;
  activeSegmentJson: Json | null;
  activeCommandJson: Json | null;
};
type ReceiptRow = SqlNumbers<Omit<CommandReceipt, "logicalTurnId" | "executionId">> & {
  logicalTurnId: string | null;
  executionId: string | null;
};
type CheckpointRow = SqlNumbers<Omit<StoredCheckpoint, "cause" | "archiveHead" | "payload">> & {
  causeJson: Json;
  archiveHeadSegmentId: string | null;
  payloadJson: Json;
};
type PublicRow = SqlNumbers<Omit<StoredPublicArchiveSegment, "previous" | "roots">> & {
  previousSegmentId: string | null;
  rootsJson: readonly Json[];
};
type PublicRootIndexRow = SqlNumbers<ArchivedPublicRootIndex>;
type TerminalRow = SqlNumbers<Omit<StoredTerminalSegment, "previous" | "entries">> & {
  previousSegmentId: string | null;
  entriesJson: readonly Json[];
};
export function headFromRow(
  row: HeadRow,
  terminal: { lastPosition: string } | null | undefined,
): ConversationHead {
  if (row.terminalSegmentId !== null && terminal == null) {
    return invalid(`Head ${row.conversationId} points to missing terminal segment`);
  }
  return readConversationHead({
    conversationId: row.conversationId,
    revision: row.revision,
    ownerEpoch: row.ownerEpoch,
    ownerRoute: row.ownerRouteJson,
    state: row.state as ConversationHead["state"],
    checkpoint: row.checkpointId === null ? null : { checkpointId: row.checkpointId },
    terminalHistory:
      row.terminalSegmentId === null
        ? null
        : { segmentId: row.terminalSegmentId, lastPosition: terminal!.lastPosition },
    activeLogicalTurnId: row.activeLogicalTurnId,
    activeExecutionId: row.activeExecutionId,
    latestCompletedExecutionId: row.latestCompletedExecutionId,
    activeSegment: row.activeSegmentJson,
    activeCommand: row.activeCommandJson,
    deletedAt: row.deletedAt === null ? null : numberValue(row.deletedAt, "deleted_at"),
    updatedAt: numberValue(row.updatedAt, "updated_at"),
  });
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
    /* CONDITIONAL-SPREAD: Omit absent logicalTurnId from stored history and commit receipts; explicit undefined is not a portable JSON value. */
    ...(row.logicalTurnId === null ? {} : { logicalTurnId: row.logicalTurnId }),
    /* CONDITIONAL-SPREAD: Omit absent executionId from stored history and commit receipts; explicit undefined is not a portable JSON value. */
    ...(row.executionId === null ? {} : { executionId: row.executionId }),
  };
}
export function checkpointFromRow(row: CheckpointRow): StoredCheckpoint {
  const value: StoredCheckpoint = {
    checkpointId: row.checkpointId,
    conversationId: row.conversationId,
    causeKey: row.causeKey,
    cause: row.causeJson,
    contentHash: row.contentHash,
    lineageId: row.lineageId,
    archiveHead: row.archiveHeadSegmentId === null ? null : { segmentId: row.archiveHeadSegmentId },
    archiveFrontierOrdinal: row.archiveFrontierOrdinal,
    nextPublicPosition: row.nextPublicPosition,
    payload: row.payloadJson,
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
    roots: row.rootsJson as readonly Json[],
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
    entries: row.entriesJson as readonly Json[],
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
    causeJson: value.cause,
    contentHash: value.contentHash,
    lineageId: value.lineageId,
    archiveHeadSegmentId: value.archiveHead?.segmentId ?? null,
    archiveFrontierOrdinal: value.archiveFrontierOrdinal,
    nextPublicPosition: value.nextPublicPosition,
    payloadJson: value.payload,
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
    rootsJson: value.roots,
    contentHash: value.contentHash,
    encodedBytes: value.encodedBytes,
    createdAt: value.createdAt,
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
  };
}
export function terminalToRow(value: StoredTerminalSegment) {
  return {
    segmentId: value.segmentId,
    conversationId: value.conversationId,
    logicalTurnId: value.logicalTurnId,
    executionId: value.executionId,
    publicationKey: value.publicationKey,
    previousSegmentId: value.previous?.segmentId ?? null,
    firstPosition: value.firstPosition,
    lastPosition: value.lastPosition,
    entriesJson: value.entries,
    contentHash: value.contentHash,
    createdAt: value.createdAt,
  };
}

export function headToRow(value: ConversationHead) {
  return {
    revision: value.revision,
    ownerEpoch: value.ownerEpoch,
    ownerRouteJson: value.ownerRoute === null ? null : value.ownerRoute,
    state: value.state,
    checkpointId: value.checkpoint?.checkpointId ?? null,
    terminalSegmentId: value.terminalHistory?.segmentId ?? null,
    activeLogicalTurnId: value.activeLogicalTurnId,
    activeExecutionId: value.activeExecutionId,
    latestCompletedExecutionId: value.latestCompletedExecutionId,
    activeSegmentJson: value.activeSegment === null ? null : value.activeSegment,
    activeCommandJson: value.activeCommand === null ? null : value.activeCommand,
    deletedAt: value.deletedAt,
    updatedAt: value.updatedAt,
  };
}
