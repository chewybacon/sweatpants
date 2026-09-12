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

export type { TransactionRunner } from "@sweatpants/durable-storage-kernel";
export {
  DurableKernelError,
  type DurableKernelErrorCode,
} from "@sweatpants/durable-storage-kernel";

/**
 * Misconfiguration of the SQLite binding itself (reserved-namespace
 * collisions, readonly authority bindings). These are SQLite-backend
 * concerns; kernel-surface failures use `DurableKernelError` and store
 * semantic failures use `ConversationStoreError` / `ExecutionStoreError`.
 */
export type SqliteBindingErrorCode =
  | "binding_conflict"
  | "binding_readonly"
  | "namespace_collision";

export class SqliteBindingError extends Error {
  constructor(
    readonly code: SqliteBindingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteBindingError";
  }
}
