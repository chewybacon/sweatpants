export type {
  ArchivedPublicRootIndex,
  CheckpointPointer,
  CommandAdmissionRequest,
  CommandAdmissionResult,
  CommandReceipt,
  CommitConversationRequest,
  CommitConversationResult,
  ConversationHead,
  ConversationHeadProposal,
  ConversationState,
  ConversationStore,
  DurableCounter,
  HeadCommitResult,
  HistoryPointer,
  Milliseconds,
  OwnerTransition,
  PublicArchivePointer,
  PublicHistoryReadPage,
  PublicProjectionBasis,
  ReadPublicHistoryBeforeRequest,
  StoredCheckpoint,
  StoredPublicArchiveSegment,
  StoredTerminalSegment,
  TerminalHistoryPage,
} from "@sweatpants/history-store/contract";

export type { DurableCounter as StorageDurableCounter } from "@sweatpants/history-store/contract";

export type {
  CommitExecutionRequest,
  CommitExecutionResult,
  ExecutionControl,
  ExecutionObjectPointer,
  ExecutionStore,
  PrivateSegmentPointer,
  StoredExecutionObject,
  StoredPrivateSegment,
} from "@sweatpants/journal-authority/store";

export type StorageErrorCode =
  | "head_conflict"
  | "command_identity_conflict"
  | "immutable_object_conflict"
  | "persisted_data_invalid"
  | "checkpoint_bound_exceeded"
  | "segment_entry_too_large"
  | "public_root_conflict"
  | "sqlite_integer_out_of_range"
  | "sqlite_transaction_failed";

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
  }
}
