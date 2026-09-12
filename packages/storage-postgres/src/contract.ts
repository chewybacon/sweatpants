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
 * Misconfiguration of the Postgres binding itself. Kernel-surface failures
 * use `DurableKernelError`; store semantic failures use
 * `ConversationStoreError` / `ExecutionStoreError`.
 */
export type PostgresBindingErrorCode = "binding_conflict" | "binding_unavailable";

export class PostgresBindingError extends Error {
  constructor(
    readonly code: PostgresBindingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PostgresBindingError";
  }
}
