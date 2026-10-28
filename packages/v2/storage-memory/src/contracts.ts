import type { OwnedJournal } from "@sweatpan.ts/durable";
export type {
  JournalBindingOptions as MemoryJournalOptions,
  OwnedChildOptions as MemoryChildOptions,
  OwnedChild as MemoryOwnedChild,
  OwnedJournal as MemoryJournal,
} from "@sweatpan.ts/durable";
/** A retained in-memory owned tree, separate from the handles and code bound to it. */
export interface MemoryJournalStore<R, Q, V, E, S = unknown> {
  readonly id: string;
  /**
   * Open a fresh root handle with an empty projection registry. Reacquire children
   * through ensureChild with the pinned program/input and trusted result projection.
   * Existing handles still share the same records but retain their own bindings.
   * Types are an assembly promise, not validation of persisted bytes. This retains
   * process-local data only; it is not disk persistence or a serialization format.
   */
  open(): OwnedJournal<R, Q, V, E, S>;
}
