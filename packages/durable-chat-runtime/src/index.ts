import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { TerminalCapsule } from "@sweatpants/durable-execution";
import type { HistoryPointer, HistoryStore, SessionHead } from "@sweatpants/history-store";

/** Explicit bounded-context fact accepted for read-model projection. */
export interface ProjectionFactEnvelope {
  readonly executionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: Json;
}

export type PublishTurnResult =
  | {
      readonly status: "published";
      readonly pointer: HistoryPointer;
      readonly headRevision: number;
    }
  | {
      readonly status: "already_published";
      readonly pointer: HistoryPointer;
      readonly headRevision: number;
    }
  | { readonly status: "conflict"; readonly actualHeadRevision: number | null };

export interface PublishTurnRequest<Entry extends Json = Json> {
  readonly capsule: TerminalCapsule;
  readonly facts: readonly ProjectionFactEnvelope[];
  readonly history: HistoryStore<Entry>;
  /** Bounded-context projector; it sees only accepted Projection Facts. */
  readonly project: (facts: readonly ProjectionFactEnvelope[]) => readonly Entry[];
  /** Marks the capsule published; must be idempotent for the same Turn. */
  readonly markPublished: (pointer: HistoryPointer) => Operation<void>;
}

/** Deterministic retry identity for one Turn publication attempt. */
export function publicationKey(capsule: TerminalCapsule, headRevision: number | null): string {
  return `${capsule.sessionId}\u0000${capsule.turnId}\u0000${headRevision ?? "genesis"}`;
}

/**
 * Publishes one terminal Turn: immutable history content is written before the
 * Session Head compare-and-swap, so an interrupted publication is resumable and
 * a repeated publication cannot duplicate a Turn.
 */
export function* publishTurn<Entry extends Json = Json>(
  request: PublishTurnRequest<Entry>,
): Operation<PublishTurnResult> {
  const { capsule, history } = request;
  const head: SessionHead | null = yield* history.loadHead(capsule.sessionId);
  if (head?.latestCompletedExecutionId === capsule.executionId && head.historyHead) {
    yield* request.markPublished(head.historyHead);
    return {
      status: "already_published",
      pointer: head.historyHead,
      headRevision: head.revision,
    };
  }

  const previous = head?.historyHead ?? null;
  const firstPosition = previous ? previous.position + 1 : 0;
  const entries = request.project(request.facts);
  const key = publicationKey(capsule, head?.revision ?? null);
  const pointer = yield* history.putSegment({
    segmentId: key,
    publicationKey: key,
    sessionId: capsule.sessionId,
    previous,
    firstPosition,
    lastPosition: firstPosition + Math.max(entries.length - 1, 0),
    entries,
  });

  const nextRevision = (head?.revision ?? -1) + 1;
  const commit = yield* history.compareAndSwapHead(capsule.sessionId, head?.revision ?? null, {
    sessionId: capsule.sessionId,
    revision: nextRevision,
    historyHead: pointer,
    activeExecutionId: null,
    latestCompletedExecutionId: capsule.executionId,
  });
  if (commit.status === "conflict") {
    return { status: "conflict", actualHeadRevision: commit.actual?.revision ?? null };
  }

  yield* request.markPublished(pointer);
  return { status: "published", pointer, headRevision: nextRevision };
}
