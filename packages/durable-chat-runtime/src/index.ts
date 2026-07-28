import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type { ProjectionFrontier, TerminalCapsule } from "@sweatpants/durable-execution";
import { HistoryStoreApi } from "@sweatpants/history-store/port";
import type { HistoryPointer, SessionHead } from "@sweatpants/history-store/contract";

/** Explicit bounded-context fact accepted for read-model projection. */
export interface ProjectionFactEnvelope {
  readonly executionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: Json;
}

export class ProjectionFactsInvalid extends Error {
  readonly code = "projection_facts_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ProjectionFactsInvalid";
  }
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
  /** Loads the facts named by the authority-accepted Terminal Capsule frontier. */
  readonly readAcceptedFacts: (
    frontier: ProjectionFrontier,
  ) => Operation<readonly ProjectionFactEnvelope[]>;
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
  const { capsule } = request;
  const history = HistoryStoreApi.operations;
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
  const facts = yield* request.readAcceptedFacts(capsule.projection);
  assertAcceptedProjectionFacts(capsule, facts);
  const entries = request.project(facts);
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

function assertAcceptedProjectionFacts(
  capsule: TerminalCapsule,
  facts: readonly ProjectionFactEnvelope[],
): void {
  if (facts.length !== capsule.projection.throughSequence) {
    throw new ProjectionFactsInvalid(
      `Expected ${capsule.projection.throughSequence} accepted Projection Facts, received ${facts.length}`,
    );
  }
  facts.forEach((fact, index) => {
    if (
      fact.executionId !== capsule.executionId ||
      fact.sessionId !== capsule.sessionId ||
      fact.turnId !== capsule.turnId
    ) {
      throw new ProjectionFactsInvalid(
        `Projection Fact ${index + 1} does not belong to Terminal Capsule ${capsule.executionId}`,
      );
    }
    if (fact.sequence !== index + 1) {
      throw new ProjectionFactsInvalid(
        `Projection Facts must be contiguous from sequence 1; received ${fact.sequence} at position ${index + 1}`,
      );
    }
  });
}
