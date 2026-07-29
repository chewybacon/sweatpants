import type { Operation } from "effection";
import type { Json } from "@sweatpants/foundation";
import type {
  ProgramIdentity,
  ProjectionFactEnvelope,
  ProjectionFrontier,
  StoredJson,
  TerminalCapsule,
} from "@sweatpants/durable-execution";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import { HistoryStoreApi } from "@sweatpants/history-store/port";
import type { HistoryPointer, SessionHead } from "@sweatpants/history-store/contract";

export type { ProjectionFactEnvelope } from "@sweatpants/durable-execution";

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

export interface BeginTurnPublicationRequest {
  readonly executionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly rootTaskId: string;
  readonly rootProgram: ProgramIdentity;
}

/** Opens bounded authority state and selects this execution as the Session's active Turn. */
export function* beginTurnPublication(
  request: BeginTurnPublicationRequest,
): Operation<BeginTurnPublicationRequest> {
  const history = HistoryStoreApi.operations;
  while (true) {
    const head = yield* history.loadHead(request.sessionId);
    if (head?.activeExecutionId) {
      const existing = yield* TurnJournalAuthority.operations.read(head.activeExecutionId);
      if (!existing || existing.format === "sweatpants.terminal-execution.v1") {
        throw new Error(
          `Session ${request.sessionId} has invalid active execution ${head.activeExecutionId}`,
        );
      }
      return {
        executionId: existing.executionId,
        sessionId: existing.sessionId,
        turnId: existing.turnId,
        rootTaskId: existing.rootTaskId,
        rootProgram: existing.rootProgram,
      };
    }
    yield* TurnJournalAuthority.operations.open(request);
    const next: SessionHead = {
      sessionId: request.sessionId,
      revision: (head?.revision ?? -1) + 1,
      historyHead: head?.historyHead ?? null,
      activeExecutionId: request.executionId,
      latestCompletedExecutionId: head?.latestCompletedExecutionId ?? null,
    };
    const commit = yield* history.compareAndSwapHead(
      request.sessionId,
      head?.revision ?? null,
      next,
    );
    if (commit.status === "accepted") return request;
  }
}

export interface CompleteAndPublishTurnRequest<Entry extends Json = Json> {
  readonly executionId: string;
  readonly outcome: StoredJson;
  readonly disposition: TerminalCapsule["disposition"];
  readonly completedAt: number;
  readonly facts: readonly ProjectionFactEnvelope[];
  readonly project: (facts: readonly ProjectionFactEnvelope[]) => readonly Entry[];
}

/** Commits terminality, then publishes and marks the capsule before returning. */
export function* completeAndPublishTurn<Entry extends Json = Json>(
  request: CompleteAndPublishTurnRequest<Entry>,
): Operation<PublishTurnResult> {
  const capsule = yield* TurnJournalAuthority.operations.complete(request);
  return yield* publishAuthorityCapsule(capsule, request.project);
}

/**
 * Publishes accepted terminal state selected by Session Head. No ProgramRuntime,
 * provider, tool runtime, child, or chat engine is invoked on this path.
 */
export interface RecoveredTurnPublication {
  readonly capsule: TerminalCapsule;
  readonly facts: readonly ProjectionFactEnvelope[];
  readonly result: PublishTurnResult;
}

export function* recoverTerminalPublication<Entry extends Json = Json>(
  sessionId: string,
  project: (facts: readonly ProjectionFactEnvelope[]) => readonly Entry[],
): Operation<RecoveredTurnPublication | null> {
  const head = yield* HistoryStoreApi.operations.loadHead(sessionId);
  const executionId = head?.activeExecutionId ?? head?.latestCompletedExecutionId;
  if (!executionId) return null;
  const record = yield* TurnJournalAuthority.operations.read(executionId);
  if (
    !record ||
    record.format !== "sweatpants.terminal-execution.v1" ||
    record.publication === "published"
  ) {
    return null;
  }
  const facts = yield* TurnJournalAuthority.operations.readAcceptedFacts(record);
  const result = yield* publishAuthorityCapsule(record, project);
  return { capsule: record, facts, result };
}

function* publishAuthorityCapsule<Entry extends Json>(
  capsule: TerminalCapsule,
  project: (facts: readonly ProjectionFactEnvelope[]) => readonly Entry[],
): Operation<PublishTurnResult> {
  while (true) {
    const result = yield* publishTurn({
      capsule,
      readAcceptedFacts: (frontier) => {
        if (
          frontier.throughSequence !== capsule.projection.throughSequence ||
          frontier.facts?.id !== capsule.projection.facts?.id
        ) {
          throw new ProjectionFactsInvalid("Publication requested a non-accepted fact frontier");
        }
        return TurnJournalAuthority.operations.readAcceptedFacts(capsule);
      },
      project,
      markPublished: function* () {
        yield* TurnJournalAuthority.operations.markPublished(capsule.executionId);
      },
    });
    if (result.status !== "conflict") return result;
  }
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
