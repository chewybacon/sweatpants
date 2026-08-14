import { canonicalSnapshot, sha256, stableTupleHash, type Json } from "@sweatpants/foundation";
import type { Operation } from "effection";
import {
  CrankError,
  type ExecutionTreeSnapshot,
  type ProgramIdentity,
  type ProjectionFactEnvelope,
  type ProjectionFrontier,
  type StoredJson,
  type TerminalCapsule,
} from "@sweatpants/durable-execution";
import { TurnJournalAuthority } from "@sweatpants/journal-authority/turn-authority";
import {
  DEFAULT_CHECKPOINT_TARGETS,
  type CheckpointPublicationTargets,
} from "@sweatpants/history-store";
import { ConversationStoreApi, ConversationStorePort } from "@sweatpants/history-store/port";
import type {
  CommandAdmissionResult,
  ConversationHead,
  ConversationHeadProposal,
  ConversationStore,
  HistoryPointer,
  StoredTerminalSegment,
} from "@sweatpants/history-store/contract";
import {
  ConversationCheckpointConflictError,
  persistConversationCheckpoint,
} from "./conversation-persistence.ts";

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
      readonly headRevision: string;
    }
  | {
      readonly status: "already_published";
      readonly pointer: HistoryPointer;
      readonly headRevision: string;
    }
  | { readonly status: "conflict"; readonly actualHeadRevision: string | null };

/** Deterministic retry identity for one terminal logical execution. */
export function publicationKey(capsule: TerminalCapsule): string {
  return stableTupleHash([capsule.sessionId, capsule.turnId, capsule.executionId]);
}

function counter(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid durable counter ${value}`);
  }
  return BigInt(value);
}

function terminalSegment(
  capsule: TerminalCapsule,
  previous: HistoryPointer | null,
  entries: readonly Json[],
): StoredTerminalSegment {
  const encoded = canonicalSnapshot(entries);
  const firstPosition = previous === null ? 0n : counter(previous.lastPosition) + 1n;
  const lastPosition = firstPosition + BigInt(Math.max(0, entries.length - 1));
  return {
    segmentId: publicationKey(capsule),
    conversationId: capsule.sessionId,
    logicalTurnId: capsule.turnId,
    executionId: capsule.executionId,
    publicationKey: publicationKey(capsule),
    previous,
    firstPosition: firstPosition.toString(10),
    lastPosition: lastPosition.toString(10),
    entries,
    contentHash: sha256(encoded.canonical),
    createdAt: capsule.completedAt,
  };
}

function idleProposal(head: ConversationHead | null): ConversationHeadProposal {
  return {
    state: "idle",
    checkpoint: head?.checkpoint ?? null,
    terminalHistory: head?.terminalHistory ?? null,
    activeLogicalTurnId: null,
    activeExecutionId: null,
    latestCompletedExecutionId: head?.latestCompletedExecutionId ?? null,
    activeSegment: null,
    activeCommand: null,
    deletedAt: null,
    ownerTransition: { kind: "clear" },
  };
}

/**
 * Publishes one terminal Turn through a bounded conversation commit. A staged
 * segment from an older interrupted attempt remains reusable, but staging is
 * not required for correctness.
 */
export function* publishTurn<Entry extends Json = Json>(
  request: PublishTurnRequest<Entry>,
): Operation<PublishTurnResult> {
  const { capsule } = request;
  const conversation = ConversationStoreApi.operations;
  const head = yield* conversation.loadHead(capsule.sessionId);
  if (head?.latestCompletedExecutionId === capsule.executionId && head.terminalHistory) {
    yield* request.markPublished(head.terminalHistory);
    return {
      status: "already_published",
      pointer: head.terminalHistory,
      headRevision: head.revision,
    };
  }

  if (head === null) {
    return { status: "conflict", actualHeadRevision: null };
  }
  const previous = head.terminalHistory;
  const facts = yield* request.readAcceptedFacts(capsule.projection);
  assertAcceptedProjectionFacts(capsule, facts);
  const entries = request.project(facts);
  const segment = terminalSegment(capsule, previous, entries);
  const pointer = { segmentId: segment.segmentId, lastPosition: segment.lastPosition };
  const publicRoots = facts.flatMap((fact) => {
    if (!fact.payload || typeof fact.payload !== "object" || Array.isArray(fact.payload)) {
      return [];
    }
    const events = fact.payload["events"];
    return Array.isArray(events) ? events : [];
  });
  let publishedHead: ConversationHead;
  try {
    const persisted = yield* persistConversationCheckpoint(conversation, {
      conversationId: capsule.sessionId,
      causeKey: stableTupleHash([capsule.executionId, capsule.turnId, "terminal"]),
      cause: {
        kind: "command",
        commandId: publicationKey(capsule),
      },
      roots: publicRoots,
      proposal: {
        state: "idle",
        terminalHistory: pointer,
        activeLogicalTurnId: null,
        activeExecutionId: null,
        latestCompletedExecutionId: capsule.executionId,
        activeSegment: null,
        activeCommand: null,
        deletedAt: null,
        ownerTransition: { kind: "clear" },
      },
      createdAt: capsule.completedAt,
      terminalHistorySegment: segment,
      targets: request.targets ?? DEFAULT_CHECKPOINT_TARGETS,
      expectedRevision: head.revision,
      expectedOwnerEpoch: head.ownerEpoch,
      expectedExecutionId: capsule.executionId,
      sealedRootCount: publicRoots.length,
    });
    publishedHead = persisted.head;
  } catch (error) {
    if (error instanceof ConversationCheckpointConflictError) {
      const current = yield* conversation.loadHead(capsule.sessionId);
      return { status: "conflict", actualHeadRevision: current?.revision ?? null };
    }
    throw error;
  }

  yield* request.markPublished(pointer);
  return { status: "published", pointer, headRevision: publishedHead.revision };
}

export interface PublishTurnRequest<Entry extends Json = Json> {
  readonly capsule: TerminalCapsule;
  readonly readAcceptedFacts: (
    frontier: ProjectionFrontier,
  ) => Operation<readonly ProjectionFactEnvelope[]>;
  readonly project: (facts: readonly ProjectionFactEnvelope[]) => readonly Entry[];
  readonly markPublished: (pointer: HistoryPointer) => Operation<void>;
  readonly targets?: CheckpointPublicationTargets;
}

export interface BeginTurnPublicationRequest {
  readonly executionId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly rootTaskId: string;
  readonly rootProgram: ProgramIdentity;
  readonly commandId: string;
  readonly commandDigest: string;
  readonly participantId: string;
  readonly acceptedAt: number;
  readonly retainUntil: number;
  /** Revision on which the caller formed this state-derived command. */
  readonly expectedRevision: string | null;
  readonly admission: "send-message" | "respond-to-elicit";
  readonly expectedLogicalTurnId?: string;
  readonly expectedExecutionId?: string;
  /** Store-classified exact retry; callers must attach/reconcile, never rerun work. */
  readonly idempotent?: boolean;
}

function commandConflict(code: string, message: string): CrankError {
  return new CrankError(code, message);
}

function isPristineConversationHead(head: ConversationHead): boolean {
  return (
    head.revision === "0" &&
    head.ownerEpoch === "0" &&
    head.state === "idle" &&
    head.checkpoint === null &&
    head.terminalHistory === null &&
    head.activeLogicalTurnId === null &&
    head.activeExecutionId === null &&
    head.latestCompletedExecutionId === null &&
    head.activeSegment === null &&
    head.activeCommand === null
  );
}

/** Atomically admits one state-derived command before any ProgramRuntime work starts. */
export function* beginTurnPublication(
  request: BeginTurnPublicationRequest,
): Operation<BeginTurnPublicationRequest> {
  const conversation = ConversationStoreApi.operations;
  const observedReceipt = yield* conversation.getCommandReceipt(
    request.sessionId,
    request.commandId,
  );
  let head = yield* conversation.loadHead(request.sessionId);

  // A command formed against an absent head may initialize exactly that absent
  // conversation. Losing this CAS is a stale-command conflict, never an
  // invitation to rebase onto the winner's revision.
  if (head === null) {
    if (request.admission !== "send-message" || request.expectedRevision !== null) {
      throw commandConflict(
        "conversation_state_changed",
        `Conversation ${request.sessionId} does not match the command basis`,
      );
    }
    const initialized = yield* conversation.compareAndSwapHead(
      request.sessionId,
      null,
      null,
      idleProposal(null),
    );
    if (initialized.status === "committed") {
      head = initialized.head;
    } else if (initialized.current && isPristineConversationHead(initialized.current)) {
      head = initialized.current;
    } else {
      throw commandConflict(
        "conversation_state_changed",
        `Conversation ${request.sessionId} was created by another command`,
      );
    }
  } else if (
    observedReceipt === null &&
    !(
      request.admission === "send-message" &&
      request.expectedRevision === null &&
      isPristineConversationHead(head)
    ) &&
    head.revision !== request.expectedRevision
  ) {
    throw commandConflict(
      "conversation_state_changed",
      `Conversation ${request.sessionId} changed after revision ${String(request.expectedRevision)}`,
    );
  }

  let admittedRequest = request;
  let existingActive: ExecutionTreeSnapshot | TerminalCapsule | null = null;
  if (request.admission === "respond-to-elicit") {
    if (
      head.activeLogicalTurnId !== request.expectedLogicalTurnId ||
      head.activeExecutionId !== request.expectedExecutionId
    ) {
      throw commandConflict(
        "active_turn_changed",
        `Conversation ${request.sessionId} active Turn changed`,
      );
    }
    existingActive = head.activeExecutionId
      ? yield* TurnJournalAuthority.operations.read(head.activeExecutionId)
      : null;
    if (!existingActive || existingActive.format === "sweatpants.terminal-execution.v1") {
      throw commandConflict(
        "active_turn_changed",
        `Conversation ${request.sessionId} has no resumable active Turn`,
      );
    }
    admittedRequest = {
      ...request,
      executionId: existingActive.executionId,
      sessionId: existingActive.sessionId,
      turnId: existingActive.turnId,
      rootTaskId: existingActive.rootTaskId,
      rootProgram: existingActive.rootProgram,
    };
  }

  const proposal: ConversationHeadProposal = {
    state: "running",
    checkpoint: head.checkpoint,
    terminalHistory: head.terminalHistory,
    activeLogicalTurnId: admittedRequest.turnId,
    activeExecutionId: admittedRequest.executionId,
    latestCompletedExecutionId: head.latestCompletedExecutionId,
    activeSegment: null,
    activeCommand: {
      kind: request.admission,
      commandId: request.commandId,
      logicalTurnId: admittedRequest.turnId,
      executionId: admittedRequest.executionId,
    },
    deletedAt: null,
    ownerTransition: {
      kind: "assign",
      ownerRoute: {
        executionId: admittedRequest.executionId,
        taskId: admittedRequest.rootTaskId,
      },
    },
  };
  const admission: CommandAdmissionResult = yield* conversation.admitCommand({
    conversationId: request.sessionId,
    commandId: request.commandId,
    commandDigest: request.commandDigest,
    participantId: request.participantId,
    acceptedAt: request.acceptedAt,
    retainUntil: request.retainUntil,
    expectedRevision: observedReceipt?.admittedRevision ?? head.revision,
    requiredState: request.admission === "send-message" ? "idle" : "parked",
    logicalTurnId: admittedRequest.turnId,
    executionId: admittedRequest.executionId,
    proposal,
  });
  if (admission.status === "head_conflict") {
    throw commandConflict(
      "conversation_state_changed",
      `Conversation ${request.sessionId} changed during command admission`,
    );
  }
  if (admission.status === "state_conflict") {
    throw commandConflict(
      request.admission === "send-message" ? "conversation_not_idle" : "active_turn_changed",
      request.admission === "send-message"
        ? `Conversation ${request.sessionId} is not idle`
        : `Conversation ${request.sessionId} is no longer parked on that Turn`,
    );
  }
  if (admission.status === "command_identity_conflict") {
    throw commandConflict(
      "command_identity_conflict",
      `Command ${request.commandId} has conflicting identity`,
    );
  }
  if (
    admission.receipt.executionId !== admittedRequest.executionId ||
    admission.receipt.logicalTurnId !== admittedRequest.turnId
  ) {
    throw commandConflict(
      "command_identity_conflict",
      `Command ${request.commandId} has conflicting execution identity`,
    );
  }
  if (
    admission.status === "idempotent" &&
    admission.head.activeExecutionId !== admittedRequest.executionId
  ) {
    throw commandConflict(
      "command_already_terminal",
      `Command ${request.commandId} already reached terminal conversation state`,
    );
  }
  if (admission.head.activeExecutionId !== admittedRequest.executionId) {
    throw new Error(`Command ${request.commandId} admitted another execution`);
  }

  if (request.admission === "respond-to-elicit") {
    return {
      ...admittedRequest,
      ...(admission.status === "idempotent" ? { idempotent: true } : {}),
    };
  }
  if (admission.status === "idempotent") {
    const existing = yield* TurnJournalAuthority.operations.read(admittedRequest.executionId);
    if (existing !== null) {
      return { ...admittedRequest, idempotent: true };
    }
  }

  // The admitted running head and receipt are deliberate recovery evidence.
  // If opening private authority fails, do not lie by moving the public head
  // back to idle: an exact retry reuses the receipt and idempotently opens the
  // same deterministic execution, while other state-derived commands reject.
  yield* TurnJournalAuthority.operations.open({
    executionId: admittedRequest.executionId,
    sessionId: admittedRequest.sessionId,
    turnId: admittedRequest.turnId,
    rootTaskId: admittedRequest.rootTaskId,
    rootProgram: admittedRequest.rootProgram,
  });
  return admittedRequest;
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

export interface RecoveredTurnPublication {
  readonly capsule: TerminalCapsule;
  readonly facts: readonly ProjectionFactEnvelope[];
  readonly result: PublishTurnResult;
}

export function* recoverTerminalPublication<Entry extends Json = Json>(
  sessionId: string,
  project: (facts: readonly ProjectionFactEnvelope[]) => readonly Entry[],
): Operation<RecoveredTurnPublication | null> {
  const head = yield* ConversationStoreApi.operations.loadHead(sessionId);
  const executionId = head?.activeExecutionId ?? head?.latestCompletedExecutionId;
  if (!executionId) {
    return null;
  }
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
  for (let attempt = 0; attempt < 64; attempt += 1) {
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
    if (result.status !== "conflict") {
      return result;
    }
  }
  throw new CrankError(
    "cas_contention",
    `Conversation ${capsule.sessionId} terminal publication exceeded its retry budget`,
  );
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

/** Installs a conversation store for an application-owned runtime scope. */
export function installConversationStore(store: ConversationStore): Operation<void> {
  return ConversationStorePort.installDriver(store);
}

export {
  hydratePublicRoots,
  persistConversationCheckpoint,
  publicRootIsEvent,
} from "./conversation-persistence.ts";
