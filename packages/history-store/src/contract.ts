import type { Json } from "@sweatpants/foundation";
import type { Operation } from "effection";

export type ConversationStoreErrorCode =
  | "immutable_object_conflict"
  | "persisted_data_invalid"
  | "checkpoint_bound_exceeded"
  | "segment_entry_too_large";

export class ConversationStoreError extends Error {
  constructor(
    readonly code: ConversationStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationStoreError";
  }
}

export type DurableCounter = string;
export type Milliseconds = number;

export type ConversationState = "idle" | "running" | "parked" | "recovering" | "deleted";

export interface CheckpointPointer {
  readonly checkpointId: string;
}

export interface PublicArchivePointer {
  readonly segmentId: string;
  readonly lastPosition: DurableCounter;
}

export interface HistoryPointer {
  readonly segmentId: string;
  readonly lastPosition: DurableCounter;
}

export interface PrivateSegmentPointer {
  readonly segmentId: string;
  readonly lastSequence: DurableCounter;
}

export interface ExecutionObjectPointer {
  readonly objectId: string;
}

export interface ConversationHead {
  readonly conversationId: string;
  readonly revision: DurableCounter;
  readonly ownerEpoch: DurableCounter;
  readonly ownerRoute: Json | null;
  readonly state: ConversationState;
  readonly checkpoint: CheckpointPointer | null;
  readonly terminalHistory: HistoryPointer | null;
  readonly activeLogicalTurnId: string | null;
  readonly activeExecutionId: string | null;
  readonly latestCompletedExecutionId: string | null;
  readonly activeSegment: Json | null;
  readonly activeCommand: Json | null;
  readonly deletedAt: Milliseconds | null;
  readonly updatedAt: Milliseconds;
}

export type OwnerTransition =
  | { readonly kind: "preserve" }
  | { readonly kind: "assign"; readonly ownerRoute: Json }
  | { readonly kind: "clear" };

export interface ConversationHeadProposal {
  readonly state: ConversationState;
  readonly checkpoint: CheckpointPointer | null;
  readonly terminalHistory: HistoryPointer | null;
  readonly activeLogicalTurnId: string | null;
  readonly activeExecutionId: string | null;
  readonly latestCompletedExecutionId: string | null;
  readonly activeSegment: Json | null;
  readonly activeCommand: Json | null;
  readonly deletedAt: Milliseconds | null;
  readonly ownerTransition: OwnerTransition;
}

export type HeadCommitResult =
  | { readonly status: "committed"; readonly head: ConversationHead }
  | { readonly status: "head_conflict"; readonly current: ConversationHead | null };

export interface CommitConversationRequest {
  readonly conversationId: string;
  readonly expectedRevision: DurableCounter | null;
  readonly expectedOwnerEpoch: DurableCounter | null;
  readonly proposal: ConversationHeadProposal;
  readonly publicArchiveSegments?: readonly StoredPublicArchiveSegment[];
  readonly checkpoint?: StoredCheckpoint;
  readonly terminalHistorySegment?: StoredTerminalSegment;
  readonly updatedAt?: Milliseconds;
}

export type CommitConversationResult =
  | {
      readonly status: "committed";
      readonly head: ConversationHead;
      readonly checkpoint?: CheckpointPointer;
      readonly terminalHistory?: HistoryPointer;
    }
  | { readonly status: "head_conflict"; readonly current: ConversationHead | null };

export interface StoredCheckpoint {
  readonly checkpointId: string;
  readonly conversationId: string;
  readonly causeKey: string;
  readonly cause: Json;
  readonly contentHash: string;
  readonly archiveHead: PublicArchivePointer | null;
  readonly archiveThroughPosition: DurableCounter;
  readonly payload: Json;
  readonly encodedBytes: number;
  readonly createdAt: Milliseconds;
}

export interface StoredPublicArchiveSegment {
  readonly segmentId: string;
  readonly conversationId: string;
  readonly previous: PublicArchivePointer | null;
  readonly firstPosition: DurableCounter;
  readonly lastPosition: DurableCounter;
  readonly roots: readonly Json[];
  readonly contentHash: string;
  readonly encodedBytes: number;
  readonly createdAt: Milliseconds;
}

export interface StoredTerminalSegment {
  readonly segmentId: string;
  readonly conversationId: string;
  readonly logicalTurnId: string;
  readonly executionId: string;
  readonly publicationKey: string;
  readonly previous: HistoryPointer | null;
  readonly firstPosition: DurableCounter;
  readonly lastPosition: DurableCounter;
  readonly entries: readonly Json[];
  readonly contentHash: string;
  readonly createdAt: Milliseconds;
}

export interface CommandReceipt {
  readonly conversationId: string;
  readonly commandId: string;
  readonly commandDigest: string;
  readonly participantId: string;
  readonly acceptedAt: Milliseconds;
  readonly retainUntil: Milliseconds;
  readonly admittedRevision: DurableCounter;
  readonly resultingRevision: DurableCounter;
  readonly logicalTurnId?: string;
  readonly executionId?: string;
}

export interface CommandAdmissionRequest {
  readonly conversationId: string;
  readonly commandId: string;
  readonly commandDigest: string;
  readonly participantId: string;
  readonly acceptedAt: Milliseconds;
  readonly retainUntil: Milliseconds;
  readonly expectedRevision: DurableCounter;
  /** Exact state in which this command was formed. Never inferred from the proposal. */
  readonly requiredState: "idle" | "parked";
  readonly logicalTurnId: string;
  readonly executionId: string;
  readonly proposal: ConversationHeadProposal;
}

export type CommandAdmissionResult =
  | {
      readonly status: "admitted" | "idempotent";
      readonly receipt: CommandReceipt;
      readonly head: ConversationHead;
    }
  | { readonly status: "head_conflict"; readonly current: ConversationHead | null }
  | { readonly status: "state_conflict"; readonly current: ConversationHead }
  | { readonly status: "command_identity_conflict"; readonly receipt: CommandReceipt };

export interface PublicArchivePage {
  readonly roots: readonly Json[];
  readonly nextCursor: string | null;
  readonly head: PublicArchivePointer | null;
}

export interface TerminalHistoryPage {
  readonly entries: readonly Json[];
  readonly nextCursor: string | null;
  readonly head: HistoryPointer | null;
}

/** Conversation authority; it never exposes response-tail persistence. */
export interface ConversationStore {
  loadHead(conversationId: string): Operation<ConversationHead | null>;
  compareAndSwapHead(
    conversationId: string,
    expectedRevision: DurableCounter | null,
    expectedOwnerEpoch: DurableCounter | null,
    proposal: ConversationHeadProposal,
  ): Operation<HeadCommitResult>;
  /** Atomically ensures bounded side records and replaces conversation authority. */
  commitConversation(request: CommitConversationRequest): Operation<CommitConversationResult>;
  admitCommand(request: CommandAdmissionRequest): Operation<CommandAdmissionResult>;
  getCommandReceipt(conversationId: string, commandId: string): Operation<CommandReceipt | null>;
  /** Optional immutable staging; commitConversation re-ensures selected content. */
  putCheckpoint(checkpoint: StoredCheckpoint): Operation<CheckpointPointer>;
  getCheckpoint(pointer: CheckpointPointer): Operation<StoredCheckpoint | null>;
  /** Optional immutable staging; a checkpoint frontier selects authoritative content. */
  putPublicArchiveSegment(segment: StoredPublicArchiveSegment): Operation<PublicArchivePointer>;
  readPublicArchivePage(
    conversationId: string,
    cursor?: string,
    limit?: number,
  ): Operation<PublicArchivePage>;
  /** Optional immutable staging; a conversation head selects authoritative content. */
  putTerminalHistorySegment(segment: StoredTerminalSegment): Operation<HistoryPointer>;
  readTerminalHistoryPage(
    conversationId: string,
    cursor?: string,
    limit?: number,
  ): Operation<TerminalHistoryPage>;
  watchHead(
    conversationId: string,
    afterRevision: DurableCounter,
    timeoutMs: number,
  ): Operation<ConversationHead | null>;
}
