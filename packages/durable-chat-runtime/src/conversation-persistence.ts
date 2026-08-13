import { canonicalSnapshot, stableTupleHash, type Json } from "@sweatpants/foundation";
import {
  checkpointHotRoots,
  checkpointHotSealedRootCount,
  checkpointPayloadFromHotRoots,
  DEFAULT_CHECKPOINT_TARGETS,
  segmentValues,
  spillUntilWithinTarget,
  type CheckpointPublicationTargets,
} from "@sweatpants/history-store";
import type {
  ConversationHead,
  ConversationHeadProposal,
  ConversationStore,
  PublicArchivePointer,
  StoredCheckpoint,
} from "@sweatpants/history-store/contract";
import type { Operation } from "effection";

export class ConversationCheckpointConflictError extends Error {
  readonly code = "head_conflict";

  constructor(message: string) {
    super(message);
    this.name = "ConversationCheckpointConflictError";
  }
}

export interface ConversationCheckpointRequest {
  readonly conversationId: string;
  readonly causeKey: string;
  readonly cause: Json;
  readonly roots: readonly Json[];
  readonly proposal: Omit<
    ConversationHeadProposal,
    "checkpoint" | "terminalHistory" | "ownerTransition"
  > & {
    readonly ownerTransition?: ConversationHeadProposal["ownerTransition"];
    readonly terminalHistory?: ConversationHead["terminalHistory"];
  };
  readonly createdAt: number;
  readonly targets?: CheckpointPublicationTargets;
  /** Expected authority identity for an owner-authored publication. */
  readonly expectedRevision?: string;
  readonly expectedOwnerEpoch?: string;
  readonly expectedExecutionId?: string | null;
  /** Number of newly supplied roots that are already sealed. */
  readonly sealedRootCount?: number;
}

export interface ConversationCheckpointResult {
  readonly checkpoint: StoredCheckpoint;
  readonly head: ConversationHead;
}

function counter(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid durable counter ${value}`);
  return BigInt(value);
}

function* writeArchiveSegments(
  store: ConversationStore,
  conversationId: string,
  previous: PublicArchivePointer | null,
  roots: readonly Json[],
  createdAt: number,
  targets: CheckpointPublicationTargets,
): Operation<PublicArchivePointer | null> {
  if (roots.length === 0) return previous;
  let archiveHead = previous;
  let nextPosition = archiveHead ? counter(archiveHead.lastPosition) + 1n : 0n;
  for (const batch of segmentValues(roots, targets.segment)) {
    const lastPosition = nextPosition + BigInt(Math.max(0, batch.entries.length - 1));
    const encoded = canonicalSnapshot(batch.entries);
    archiveHead = yield* store.putPublicArchiveSegment({
      segmentId: stableTupleHash([
        conversationId,
        nextPosition.toString(10),
        lastPosition.toString(10),
        encoded.sha,
      ]),
      conversationId,
      previous: archiveHead,
      firstPosition: nextPosition.toString(10),
      lastPosition: lastPosition.toString(10),
      roots: batch.entries,
      contentHash: encoded.sha,
      encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
      createdAt,
    });
    nextPosition = lastPosition + 1n;
  }
  return archiveHead;
}

/** Persists only the new roots, spilling previously hot sealed roots into archive segments. */
export function* persistConversationCheckpoint(
  store: ConversationStore,
  request: ConversationCheckpointRequest,
): Operation<ConversationCheckpointResult> {
  const targets = request.targets ?? DEFAULT_CHECKPOINT_TARGETS;
  const head = yield* store.loadHead(request.conversationId);
  if (!head) throw new Error(`Conversation ${request.conversationId} has no admitted head`);
  if (
    (request.expectedRevision !== undefined && head.revision !== request.expectedRevision) ||
    (request.expectedOwnerEpoch !== undefined && head.ownerEpoch !== request.expectedOwnerEpoch) ||
    (request.expectedExecutionId !== undefined &&
      head.activeExecutionId !== null &&
      head.activeExecutionId !== request.expectedExecutionId)
  ) {
    throw new ConversationCheckpointConflictError(
      `Conversation ${request.conversationId} changed before checkpoint publication`,
    );
  }
  const previousCheckpoint = head.checkpoint ? yield* store.getCheckpoint(head.checkpoint) : null;
  const previousHot = previousCheckpoint ? [...checkpointHotRoots(previousCheckpoint.payload)] : [];
  const previousSealedRootCount = previousCheckpoint
    ? checkpointHotSealedRootCount(previousCheckpoint.payload)
    : 0;
  const combined = [...previousHot, ...request.roots];
  const sealedRootCount =
    previousSealedRootCount + (request.sealedRootCount ?? request.roots.length);
  if (
    !Number.isSafeInteger(sealedRootCount) ||
    sealedRootCount < 0 ||
    sealedRootCount > combined.length
  ) {
    throw new Error("Checkpoint sealed root count is invalid");
  }
  const { spilled, hotRoots } = spillUntilWithinTarget(combined, sealedRootCount, targets.spill);
  const hotSealedRootCount = Math.max(0, sealedRootCount - spilled.length);
  const archiveHead = yield* writeArchiveSegments(
    store,
    request.conversationId,
    previousCheckpoint?.archiveHead ?? null,
    spilled,
    request.createdAt,
    targets,
  );
  const payloadValue = checkpointPayloadFromHotRoots(hotRoots, hotSealedRootCount);
  const payload = canonicalSnapshot(payloadValue);
  const cause = canonicalSnapshot(request.cause);
  const checkpoint: StoredCheckpoint = {
    checkpointId: stableTupleHash([request.conversationId, request.causeKey, payload.sha]),
    conversationId: request.conversationId,
    causeKey: request.causeKey,
    cause: cause.value,
    contentHash: payload.sha,
    archiveHead,
    archiveThroughPosition: archiveHead?.lastPosition ?? "0",
    payload: payload.value,
    encodedBytes: new TextEncoder().encode(payload.canonical).byteLength,
    createdAt: request.createdAt,
  };
  const pointer = yield* store.putCheckpoint(checkpoint);
  const proposal: ConversationHeadProposal = {
    ...request.proposal,
    checkpoint: pointer,
    terminalHistory: request.proposal.terminalHistory ?? head.terminalHistory,
    ownerTransition: request.proposal.ownerTransition ?? { kind: "preserve" },
  };
  const committed = yield* store.compareAndSwapHead(
    request.conversationId,
    request.expectedRevision ?? head.revision,
    request.expectedOwnerEpoch ?? head.ownerEpoch,
    proposal,
  );
  if (committed.status !== "committed") {
    throw new ConversationCheckpointConflictError(
      `Conversation ${request.conversationId} checkpoint head CAS lost`,
    );
  }
  return { checkpoint, head: committed.head };
}

/** Reconstructs archive roots through the checkpoint frontier plus remaining hot roots. */
export function* hydratePublicRoots(
  store: ConversationStore,
  conversationId: string,
  checkpoint: StoredCheckpoint,
): Operation<readonly Json[]> {
  const hotRoots = checkpointHotRoots(checkpoint.payload);
  if (checkpoint.archiveHead === null) return hotRoots;
  const needed = counter(checkpoint.archiveThroughPosition) + 1n;
  const archived: Json[] = [];
  let cursor: string | undefined;
  while (BigInt(archived.length) < needed) {
    const remaining = needed - BigInt(archived.length);
    const limit = remaining > 100n ? 100 : Number(remaining);
    const page = yield* store.readPublicArchivePage(conversationId, cursor, limit);
    archived.push(...page.roots);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return [...archived.slice(0, Number(needed)), ...hotRoots];
}

export function publicRootIsEvent(root: Json): boolean {
  return (
    root !== null &&
    typeof root === "object" &&
    !Array.isArray(root) &&
    typeof root["type"] === "string"
  );
}
