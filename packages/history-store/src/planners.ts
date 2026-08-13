import {
  DurableCollections,
  type DurableMutation,
  type ImmutableEnsure,
  type StoredAuthorityRecord,
} from "@sweatpants/durable-storage-kernel";
import type {
  CommandAdmissionRequest,
  CommandAdmissionResult,
  CommandReceipt,
  CommitConversationRequest,
  ConversationHead,
  ConversationHeadProposal,
  HeadCommitResult,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
} from "./contract.ts";
import {
  conversationKeys,
  decodeAuthorityHead,
  encodeCheckpoint,
  encodeCommandReceipt,
  encodeConversationHead,
  encodePublicSegment,
  encodeTerminalSegment,
} from "./persistence.ts";

export type ConversationPlan<Result> =
  | { readonly kind: "complete"; readonly result: Result }
  | { readonly kind: "apply"; readonly mutation: DurableMutation };

function counter(value: string, field: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${field} is not a durable counter`);
  }
  return BigInt(value);
}

function next(value: string): string {
  return (counter(value, "counter") + 1n).toString(10);
}

export function validateConversationProposal(proposal: ConversationHeadProposal): void {
  if (proposal.state === "deleted" && proposal.deletedAt === null) {
    throw new Error("deleted conversation heads require deletedAt");
  }
  if (proposal.state !== "deleted" && proposal.deletedAt !== null) {
    throw new Error("non-deleted conversation heads cannot have deletedAt");
  }
  if (proposal.state === "deleted" && proposal.ownerTransition.kind !== "clear") {
    throw new Error("deleted conversation heads require a cleared owner");
  }
}

export function nextConversationHead(
  conversationId: string,
  current: ConversationHead | null,
  proposal: ConversationHeadProposal,
  updatedAt: number,
): ConversationHead {
  validateConversationProposal(proposal);
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
    throw new Error("conversation updatedAt must be a non-negative safe integer");
  }
  const revision = current === null ? "0" : next(current.revision);
  const ownerEpoch =
    current === null
      ? "0"
      : proposal.ownerTransition.kind === "assign"
        ? next(current.ownerEpoch)
        : current.ownerEpoch;
  return {
    conversationId,
    revision,
    ownerEpoch,
    ownerRoute:
      proposal.ownerTransition.kind === "assign"
        ? structuredClone(proposal.ownerTransition.ownerRoute)
        : proposal.ownerTransition.kind === "preserve"
          ? structuredClone(current?.ownerRoute ?? null)
          : null,
    state: proposal.state,
    checkpoint: structuredClone(proposal.checkpoint),
    terminalHistory: structuredClone(proposal.terminalHistory),
    activeLogicalTurnId: proposal.activeLogicalTurnId,
    activeExecutionId: proposal.activeExecutionId,
    latestCompletedExecutionId: proposal.latestCompletedExecutionId,
    activeSegment: structuredClone(proposal.activeSegment),
    activeCommand: structuredClone(proposal.activeCommand),
    deletedAt: proposal.deletedAt,
    updatedAt,
  };
}

function headMutation(
  conversationId: string,
  current: ConversationHead | null,
  expectedRevision: string | null,
  expectedOwnerEpoch: string | null,
  proposal: ConversationHeadProposal,
  updatedAt: number,
  ensures: readonly ImmutableEnsure[] = [],
): DurableMutation {
  const head = nextConversationHead(conversationId, current, proposal, updatedAt);
  return {
    ensures,
    authority: {
      name: "conversation-head",
      collection: DurableCollections.conversationHeads,
      key: conversationKeys.head(conversationId),
      expected: { revision: expectedRevision, fence: expectedOwnerEpoch },
      next: {
        revision: head.revision,
        fence: head.ownerEpoch,
        value: encodeConversationHead(head),
      },
    },
  };
}

export function planHeadCommit(input: {
  readonly conversationId: string;
  readonly currentRecord: StoredAuthorityRecord | null;
  readonly expectedRevision: string | null;
  readonly expectedOwnerEpoch: string | null;
  readonly proposal: ConversationHeadProposal;
  readonly updatedAt: number;
}): ConversationPlan<HeadCommitResult> {
  const current = input.currentRecord === null ? null : decodeAuthorityHead(input.currentRecord);
  if (
    current === null
      ? input.expectedRevision !== null || input.expectedOwnerEpoch !== null
      : current.revision !== input.expectedRevision || current.ownerEpoch !== input.expectedOwnerEpoch
  ) {
    return { kind: "complete", result: { status: "head_conflict", current } };
  }
  return {
    kind: "apply",
    mutation: headMutation(
      input.conversationId,
      current,
      input.expectedRevision,
      input.expectedOwnerEpoch,
      input.proposal,
      input.updatedAt,
    ),
  };
}

export function checkpointEnsure(checkpoint: StoredCheckpoint): ImmutableEnsure {
  return {
    name: "checkpoint",
    collection: DurableCollections.conversationCheckpoints,
    key: conversationKeys.checkpoint(checkpoint.checkpointId),
    alternateKeys: [
      conversationKeys.checkpointCause(checkpoint.conversationId, checkpoint.causeKey),
    ],
    fingerprint: checkpoint.contentHash,
    value: encodeCheckpoint(checkpoint),
  };
}

export function publicSegmentEnsure(
  segment: StoredPublicArchiveSegment,
  index: number | string = segment.segmentId,
): ImmutableEnsure {
  return {
    name: `public-archive-${index}`,
    collection: DurableCollections.conversationPublicSegments,
    key: conversationKeys.publicSegment(segment.segmentId),
    alternateKeys: [
      conversationKeys.publicPosition(
        segment.conversationId,
        segment.firstPosition,
        segment.segmentId,
      ),
    ],
    fingerprint: segment.contentHash,
    value: encodePublicSegment(segment),
  };
}

export function terminalSegmentEnsure(segment: StoredTerminalSegment): ImmutableEnsure {
  return {
    name: "terminal-history",
    collection: DurableCollections.conversationTerminalSegments,
    key: conversationKeys.terminalSegment(segment.segmentId),
    alternateKeys: [
      conversationKeys.terminalPublication(segment.conversationId, segment.publicationKey),
      conversationKeys.terminalPosition(
        segment.conversationId,
        segment.firstPosition,
        segment.segmentId,
      ),
    ],
    fingerprint: segment.contentHash,
    value: encodeTerminalSegment(segment),
  };
}

export function planConversationCommit(input: {
  readonly request: CommitConversationRequest;
  readonly currentRecord: StoredAuthorityRecord | null;
  readonly updatedAt: number;
}): ConversationPlan<HeadCommitResult> {
  const { request } = input;
  const current = input.currentRecord === null ? null : decodeAuthorityHead(input.currentRecord);
  for (const segment of request.publicArchiveSegments ?? []) {
    if (segment.conversationId !== request.conversationId) {
      throw new Error("public archive segment is outside the committed conversation");
    }
  }
  if (request.checkpoint && request.checkpoint.conversationId !== request.conversationId) {
    throw new Error("checkpoint is outside the committed conversation");
  }
  if (
    request.terminalHistorySegment &&
    request.terminalHistorySegment.conversationId !== request.conversationId
  ) {
    throw new Error("terminal segment is outside the committed conversation");
  }
  const archiveSegments = request.publicArchiveSegments ?? [];
  for (let index = 1; index < archiveSegments.length; index += 1) {
    const previous = archiveSegments[index - 1]!;
    const segment = archiveSegments[index]!;
    if (
      segment.previous?.segmentId !== previous.segmentId ||
      segment.previous.lastPosition !== previous.lastPosition ||
      counter(segment.firstPosition, "archive first position") !==
        counter(previous.lastPosition, "archive previous position") + 1n
    ) {
      throw new Error("conversation commit contains a non-contiguous public archive chain");
    }
  }
  const lastArchive = archiveSegments.at(-1);
  if (
    lastArchive &&
    (request.checkpoint?.archiveHead?.segmentId !== lastArchive.segmentId ||
      request.checkpoint.archiveHead.lastPosition !== lastArchive.lastPosition)
  ) {
    throw new Error("checkpoint does not select the committed public archive frontier");
  }
  if (
    current === null
      ? request.expectedRevision !== null || request.expectedOwnerEpoch !== null
      : current.revision !== request.expectedRevision ||
        current.ownerEpoch !== request.expectedOwnerEpoch
  ) {
    return { kind: "complete", result: { status: "head_conflict", current } };
  }
  if (
    request.checkpoint &&
    request.proposal.checkpoint?.checkpointId !== request.checkpoint.checkpointId
  ) {
    throw new Error("conversation proposal must select the checkpoint committed with it");
  }
  if (
    request.terminalHistorySegment &&
    request.proposal.terminalHistory?.segmentId !== request.terminalHistorySegment.segmentId
  ) {
    throw new Error("conversation proposal must select the terminal segment committed with it");
  }
  if (request.terminalHistorySegment) {
    const previous = request.terminalHistorySegment.previous;
    if (
      previous?.segmentId !== current?.terminalHistory?.segmentId ||
      previous?.lastPosition !== current?.terminalHistory?.lastPosition
    ) {
      throw new Error("terminal segment does not extend the current conversation frontier");
    }
  }
  const ensures: ImmutableEnsure[] = [
    ...(request.publicArchiveSegments ?? []).map((segment, index) =>
      publicSegmentEnsure(segment, index),
    ),
    ...(request.checkpoint ? [checkpointEnsure(request.checkpoint)] : []),
    ...(request.terminalHistorySegment
      ? [terminalSegmentEnsure(request.terminalHistorySegment)]
      : []),
  ];
  return {
    kind: "apply",
    mutation: headMutation(
      request.conversationId,
      current,
      request.expectedRevision,
      request.expectedOwnerEpoch,
      request.proposal,
      input.updatedAt,
      ensures,
    ),
  };
}

export function planCommandAdmission(input: {
  readonly request: CommandAdmissionRequest;
  readonly currentRecord: StoredAuthorityRecord | null;
}): ConversationPlan<CommandAdmissionResult> {
  const { request } = input;
  const current = input.currentRecord === null ? null : decodeAuthorityHead(input.currentRecord);
  if (current === null || current.revision !== request.expectedRevision) {
    return { kind: "complete", result: { status: "head_conflict", current } };
  }
  if (current.state !== "idle") {
    return { kind: "complete", result: { status: "state_conflict", current } };
  }
  const head = nextConversationHead(
    request.conversationId,
    current,
    request.proposal,
    request.acceptedAt,
  );
  const receipt: CommandReceipt = {
    conversationId: request.conversationId,
    commandId: request.commandId,
    commandDigest: request.commandDigest,
    participantId: request.participantId,
    acceptedAt: request.acceptedAt,
    retainUntil: request.retainUntil,
    admittedRevision: request.expectedRevision,
    resultingRevision: head.revision,
    logicalTurnId: request.logicalTurnId,
    executionId: request.executionId,
  };
  return {
    kind: "apply",
    mutation: {
      claim: {
        name: "command-receipt",
        collection: DurableCollections.conversationCommandReceipts,
        key: conversationKeys.receipt(request.conversationId, request.commandId),
        fingerprint: request.commandDigest,
        value: encodeCommandReceipt(receipt),
      },
      ensures: [],
      authority: {
        name: "conversation-head",
        collection: DurableCollections.conversationHeads,
        key: conversationKeys.head(request.conversationId),
        expected: { revision: request.expectedRevision, fence: current.ownerEpoch },
        next: {
          revision: head.revision,
          fence: head.ownerEpoch,
          value: encodeConversationHead(head),
        },
      },
    },
  };
}
