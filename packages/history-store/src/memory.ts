import { canonicalJson, canonicalSnapshot, type Json } from "@sweatpants/foundation";
import { call, sleep, type Operation } from "effection";
import { assertCheckpointPayload } from "./checkpoint-payload.ts";
import {
  ConversationStoreError,
  type CheckpointPointer,
  type CommandAdmissionRequest,
  type CommandAdmissionResult,
  type CommandReceipt,
  type ConversationHead,
  type ConversationHeadProposal,
  type ConversationStore,
  type HeadCommitResult,
  type HistoryPointer,
  type PublicArchivePage,
  type PublicArchivePointer,
  type StoredCheckpoint,
  type StoredPublicArchiveSegment,
  type StoredTerminalSegment,
  type TerminalHistoryPage,
} from "./contract.ts";

export function createMemoryConversationStore(): ConversationStore {
  const heads = new Map<string, ConversationHead>();
  const receipts = new Map<string, Map<string, CommandReceipt>>();
  const checkpoints = new Map<string, StoredCheckpoint>();
  const checkpointByCause = new Map<string, Map<string, string>>();
  const publicSegments = new Map<string, StoredPublicArchiveSegment>();
  const terminalSegments = new Map<string, StoredTerminalSegment>();
  const terminalByPublication = new Map<string, string>();

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function counter(value: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new ConversationStoreError(
        "persisted_data_invalid",
        `Invalid durable counter: ${value}`,
      );
    }
    return BigInt(value);
  }

  function next(value: string): string {
    return (counter(value) + 1n).toString(10);
  }

  function causeKey(conversationId: string, cause: string): string {
    return canonicalJson([conversationId, cause]);
  }

  function validateProposal(proposal: ConversationHeadProposal): void {
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

  function commitHead(
    conversationId: string,
    expectedRevision: string | null,
    expectedOwnerEpoch: string | null,
    proposal: ConversationHeadProposal,
  ): HeadCommitResult {
    validateProposal(proposal);
    const current = heads.get(conversationId) ?? null;
    if (current === null) {
      if (expectedRevision !== null || expectedOwnerEpoch !== null) {
        return { status: "head_conflict", current: null };
      }
      const head: ConversationHead = {
        conversationId,
        revision: "0",
        ownerEpoch: "0",
        ownerRoute:
          proposal.ownerTransition.kind === "assign"
            ? clone(proposal.ownerTransition.ownerRoute)
            : null,
        state: proposal.state,
        checkpoint: clone(proposal.checkpoint),
        terminalHistory: clone(proposal.terminalHistory),
        activeLogicalTurnId: proposal.activeLogicalTurnId,
        activeExecutionId: proposal.activeExecutionId,
        latestCompletedExecutionId: proposal.latestCompletedExecutionId,
        activeSegment: clone(proposal.activeSegment),
        activeCommand: clone(proposal.activeCommand),
        deletedAt: proposal.deletedAt,
        updatedAt: Date.now(),
      };
      heads.set(conversationId, head);
      return { status: "committed", head: clone(head) };
    }

    if (current.revision !== expectedRevision || current.ownerEpoch !== expectedOwnerEpoch) {
      return { status: "head_conflict", current: clone(current) };
    }

    const ownerEpoch =
      proposal.ownerTransition.kind === "assign" ? next(current.ownerEpoch) : current.ownerEpoch;
    const head: ConversationHead = {
      conversationId,
      revision: next(current.revision),
      ownerEpoch,
      ownerRoute:
        proposal.ownerTransition.kind === "assign"
          ? clone(proposal.ownerTransition.ownerRoute)
          : proposal.ownerTransition.kind === "preserve"
            ? clone(current.ownerRoute)
            : null,
      state: proposal.state,
      checkpoint: clone(proposal.checkpoint),
      terminalHistory: clone(proposal.terminalHistory),
      activeLogicalTurnId: proposal.activeLogicalTurnId,
      activeExecutionId: proposal.activeExecutionId,
      latestCompletedExecutionId: proposal.latestCompletedExecutionId,
      activeSegment: clone(proposal.activeSegment),
      activeCommand: clone(proposal.activeCommand),
      deletedAt: proposal.deletedAt,
      updatedAt: Date.now(),
    };
    heads.set(conversationId, head);
    return { status: "committed", head: clone(head) };
  }

  function admit(request: CommandAdmissionRequest): CommandAdmissionResult {
    const byCommand = receipts.get(request.conversationId);
    const existing = byCommand?.get(request.commandId);
    if (existing !== undefined) {
      if (existing.commandDigest !== request.commandDigest) {
        return { status: "command_identity_conflict", receipt: clone(existing) };
      }
      const head = heads.get(request.conversationId);
      if (!head) {
        throw new Error("command receipt exists without a conversation head");
      }
      return { status: "idempotent", receipt: clone(existing), head: clone(head) };
    }

    const current = heads.get(request.conversationId) ?? null;
    if (current === null || current.revision !== request.expectedRevision) {
      return { status: "head_conflict", current: clone(current) };
    }
    if (current.state !== "idle") {
      return { status: "state_conflict", current: clone(current) };
    }

    const committed = commitHead(
      request.conversationId,
      request.expectedRevision,
      current.ownerEpoch,
      request.proposal,
    );
    if (committed.status !== "committed") return committed;

    const receipt: CommandReceipt = {
      conversationId: request.conversationId,
      commandId: request.commandId,
      commandDigest: request.commandDigest,
      participantId: request.participantId,
      acceptedAt: request.acceptedAt,
      retainUntil: request.retainUntil,
      admittedRevision: request.expectedRevision,
      resultingRevision: committed.head.revision,
      logicalTurnId: request.logicalTurnId,
      executionId: request.executionId,
    };
    const map = byCommand ?? new Map<string, CommandReceipt>();
    map.set(request.commandId, receipt);
    receipts.set(request.conversationId, map);
    return { status: "admitted", receipt: clone(receipt), head: clone(committed.head) };
  }

  function putCheckpoint(checkpoint: StoredCheckpoint): CheckpointPointer {
    assertCheckpointPayload(checkpoint.payload);
    const encoded = canonicalSnapshot(checkpoint.payload);
    if (encoded.sha !== checkpoint.contentHash) {
      throw new ConversationStoreError(
        "persisted_data_invalid",
        `Checkpoint ${checkpoint.checkpointId} content hash does not match payload`,
      );
    }
    const existing = checkpoints.get(checkpoint.checkpointId);
    if (existing !== undefined) {
      if (existing.contentHash !== checkpoint.contentHash) {
        throw new ConversationStoreError(
          "immutable_object_conflict",
          `Checkpoint ${checkpoint.checkpointId} has another content hash`,
        );
      }
      return { checkpointId: existing.checkpointId };
    }
    const byCause = checkpointByCause.get(checkpoint.conversationId);
    const existingId = byCause?.get(checkpoint.causeKey);
    if (existingId !== undefined) {
      const existingCause = checkpoints.get(existingId)!;
      if (existingCause.contentHash !== checkpoint.contentHash) {
        throw new ConversationStoreError(
          "immutable_object_conflict",
          `Checkpoint ${checkpoint.conversationId}/${checkpoint.causeKey} conflicts`,
        );
      }
      return { checkpointId: existingCause.checkpointId };
    }
    checkpoints.set(checkpoint.checkpointId, clone(checkpoint));
    const causes = byCause ?? new Map<string, string>();
    causes.set(checkpoint.causeKey, checkpoint.checkpointId);
    checkpointByCause.set(checkpoint.conversationId, causes);
    return { checkpointId: checkpoint.checkpointId };
  }

  function putPublic(segment: StoredPublicArchiveSegment): PublicArchivePointer {
    const existing = publicSegments.get(segment.segmentId);
    if (existing !== undefined) {
      if (existing.contentHash !== segment.contentHash) {
        throw new ConversationStoreError(
          "immutable_object_conflict",
          `Public archive segment ${segment.segmentId} conflicts`,
        );
      }
      return { segmentId: existing.segmentId, lastPosition: existing.lastPosition };
    }
    publicSegments.set(segment.segmentId, clone(segment));
    return { segmentId: segment.segmentId, lastPosition: segment.lastPosition };
  }

  function putTerminal(segment: StoredTerminalSegment): HistoryPointer {
    const publication = causeKey(segment.conversationId, segment.publicationKey);
    const existingId = terminalByPublication.get(publication);
    if (existingId !== undefined) {
      const existing = terminalSegments.get(existingId)!;
      if (existing.contentHash !== segment.contentHash) {
        throw new ConversationStoreError(
          "immutable_object_conflict",
          `Terminal publication ${publication} conflicts`,
        );
      }
      return { segmentId: existing.segmentId, lastPosition: existing.lastPosition };
    }
    const existing = terminalSegments.get(segment.segmentId);
    if (existing !== undefined) {
      if (existing.contentHash !== segment.contentHash) {
        throw new ConversationStoreError(
          "immutable_object_conflict",
          `Terminal segment ${segment.segmentId} conflicts`,
        );
      }
      return { segmentId: existing.segmentId, lastPosition: existing.lastPosition };
    }
    terminalSegments.set(segment.segmentId, clone(segment));
    terminalByPublication.set(publication, segment.segmentId);
    return { segmentId: segment.segmentId, lastPosition: segment.lastPosition };
  }

  function page<T extends { firstPosition: string; lastPosition: string }>(
    rows: readonly T[],
    cursor: string | undefined,
    limit: number,
    values: (row: T) => readonly Json[],
  ): { values: Json[]; nextCursor: string | null; row: T | undefined } {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new ConversationStoreError("persisted_data_invalid", `Invalid page limit ${limit}`);
    }
    const ordered = [...rows].sort((left, right) => {
      const position = counter(left.firstPosition) - counter(right.firstPosition);
      return position === 0n ? 0 : position < 0n ? -1 : 1;
    });
    const all: Json[] = [];
    let expected: bigint | null = null;
    for (const row of ordered) {
      const entries = values(row);
      const first = counter(row.firstPosition);
      const last = counter(row.lastPosition);
      if (last < first || last - first + 1n !== BigInt(entries.length)) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          "Segment has an invalid position range",
        );
      }
      if (expected !== null && first !== expected) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Segment chain is not contiguous at ${expected}`,
        );
      }
      expected = last + 1n;
      all.push(...entries);
    }
    const start =
      cursor === undefined
        ? ordered.length > 0
          ? counter(ordered[0]!.firstPosition)
          : 0n
        : counter(cursor);
    const first = ordered.length > 0 ? counter(ordered[0]!.firstPosition) : 0n;
    const end = first + BigInt(all.length);
    if (start < first || start > end) {
      throw new ConversationStoreError(
        "persisted_data_invalid",
        `Cursor ${start} is outside its segment chain`,
      );
    }
    const offsetValue = start - first;
    if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConversationStoreError("persisted_data_invalid", `Cursor ${start} is too large`);
    }
    const offset = Number(offsetValue);
    const result = all.slice(offset, offset + limit);
    const nextCursorValue = start + BigInt(result.length);
    return {
      values: result,
      nextCursor: nextCursorValue < end ? nextCursorValue.toString(10) : null,
      row: ordered.at(-1),
    };
  }

  function publicRowsForRead(conversationId: string): {
    readonly rows: readonly StoredPublicArchiveSegment[];
    readonly head: PublicArchivePointer | null;
  } {
    const conversationHead = heads.get(conversationId);
    if (conversationHead === undefined) {
      const rows = [...publicSegments.values()].filter(
        (row) => row.conversationId === conversationId,
      );
      const last = [...rows]
        .sort((a, b) => (counter(a.firstPosition) < counter(b.firstPosition) ? -1 : 1))
        .at(-1);
      return {
        rows,
        head: last ? { segmentId: last.segmentId, lastPosition: last.lastPosition } : null,
      };
    }
    if (conversationHead.checkpoint === null) return { rows: [], head: null };
    const checkpoint = checkpoints.get(conversationHead.checkpoint.checkpointId);
    if (checkpoint === undefined) {
      throw new ConversationStoreError(
        "persisted_data_invalid",
        `Head points to missing checkpoint ${conversationHead.checkpoint.checkpointId}`,
      );
    }
    if (checkpoint.archiveHead === null) return { rows: [], head: null };
    const reverse: StoredPublicArchiveSegment[] = [];
    const seen = new Set<string>();
    let segmentId: string | null = checkpoint.archiveHead.segmentId;
    while (segmentId !== null) {
      if (seen.has(segmentId)) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Public archive chain contains a cycle at ${segmentId}`,
        );
      }
      seen.add(segmentId);
      const row = publicSegments.get(segmentId);
      if (row === undefined || row.conversationId !== conversationId) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Public archive chain points outside conversation ${conversationId}`,
        );
      }
      reverse.push(row);
      segmentId = row.previous?.segmentId ?? null;
    }
    const rows = reverse.reverse();
    return { rows, head: checkpoint.archiveHead };
  }

  function terminalRowsForRead(conversationId: string): {
    readonly rows: readonly StoredTerminalSegment[];
    readonly head: HistoryPointer | null;
  } {
    const conversationHead = heads.get(conversationId);
    if (conversationHead === undefined) {
      const rows = [...terminalSegments.values()].filter(
        (row) => row.conversationId === conversationId,
      );
      const last = [...rows]
        .sort((a, b) => (counter(a.firstPosition) < counter(b.firstPosition) ? -1 : 1))
        .at(-1);
      return {
        rows,
        head: last ? { segmentId: last.segmentId, lastPosition: last.lastPosition } : null,
      };
    }
    if (conversationHead.terminalHistory === null) return { rows: [], head: null };
    const reverse: StoredTerminalSegment[] = [];
    const seen = new Set<string>();
    let segmentId: string | null = conversationHead.terminalHistory.segmentId;
    while (segmentId !== null) {
      if (seen.has(segmentId)) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Terminal history chain contains a cycle at ${segmentId}`,
        );
      }
      seen.add(segmentId);
      const row = terminalSegments.get(segmentId);
      if (row === undefined || row.conversationId !== conversationId) {
        throw new ConversationStoreError(
          "persisted_data_invalid",
          `Terminal history chain points outside conversation ${conversationId}`,
        );
      }
      reverse.push(row);
      segmentId = row.previous?.segmentId ?? null;
    }
    const rows = reverse.reverse();
    return { rows, head: conversationHead.terminalHistory };
  }

  return {
    *loadHead(conversationId): Operation<ConversationHead | null> {
      return yield* call(() => clone(heads.get(conversationId) ?? null));
    },
    *compareAndSwapHead(
      conversationId,
      expectedRevision,
      expectedOwnerEpoch,
      proposal,
    ): Operation<HeadCommitResult> {
      return yield* call(() =>
        commitHead(conversationId, expectedRevision, expectedOwnerEpoch, proposal),
      );
    },
    *admitCommand(request): Operation<CommandAdmissionResult> {
      return yield* call(() => admit(request));
    },
    *getCommandReceipt(conversationId, commandId): Operation<CommandReceipt | null> {
      return yield* call(() => clone(receipts.get(conversationId)?.get(commandId) ?? null));
    },
    *putCheckpoint(checkpoint): Operation<CheckpointPointer> {
      return yield* call(() => putCheckpoint(checkpoint));
    },
    *getCheckpoint(pointer): Operation<StoredCheckpoint | null> {
      return yield* call(() => clone(checkpoints.get(pointer.checkpointId) ?? null));
    },
    *putPublicArchiveSegment(segment): Operation<PublicArchivePointer> {
      return yield* call(() => putPublic(segment));
    },
    *readPublicArchivePage(conversationId, cursor, limit = 50): Operation<PublicArchivePage> {
      return yield* call(() => {
        const authoritative = publicRowsForRead(conversationId);
        const result = page(authoritative.rows, cursor, limit, (row) => row.roots);
        return {
          roots: result.values,
          nextCursor: result.nextCursor,
          head: authoritative.head,
        };
      });
    },
    *putTerminalHistorySegment(segment): Operation<HistoryPointer> {
      return yield* call(() => putTerminal(segment));
    },
    *readTerminalHistoryPage(conversationId, cursor, limit = 50): Operation<TerminalHistoryPage> {
      return yield* call(() => {
        const authoritative = terminalRowsForRead(conversationId);
        const result = page(authoritative.rows, cursor, limit, (row) => row.entries);
        return {
          entries: result.values,
          nextCursor: result.nextCursor,
          head: authoritative.head,
        };
      });
    },
    *watchHead(conversationId, afterRevision, timeoutMs): Operation<ConversationHead | null> {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      while (true) {
        const current = heads.get(conversationId);
        if (current && counter(current.revision) > counter(afterRevision)) return clone(current);
        if (Date.now() >= deadline) return null;
        yield* sleep(Math.min(10, deadline - Date.now()));
      }
    },
  };
}
