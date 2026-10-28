import type { Operation, Outcome } from "@standard-durability/core";
import type {
  Journal,
  CancellationJournal,
  Attempts,
  AttemptControl,
  Interactions,
  ChildLink,
} from "@sweatpan.ts/durable";

/** In-memory values must be structured-cloneable. Equality defines duplicate delivery. */
export interface MemoryJournalOptions {
  readonly program: string;
  readonly equals: (left: unknown, right: unknown) => boolean;
}

/** Process-local owned call assembly; program/input are compared on reacquisition. */
export interface MemoryChildOptions<R, V, E> {
  readonly program: string;
  readonly input: unknown;
  /** Pure terminal projection. Must not perform effects; failures leave both journals unchanged. */
  readonly outcome: (value: R) => Outcome<V, E>;
}

/** Typed journal capabilities sharing the adapter's synchronous transaction boundary. */
export interface MemoryJournal<R, Q, V, E, S = unknown> extends Journal<R, Q, V, E, S, never> {
  readonly id: string;
  readonly cancellation: CancellationJournal<Q, never>;
  readonly attempts: Attempts<Q, V, E, never>;
  readonly attemptControl: AttemptControl<Q, V, E, never>;
  readonly interactions: Interactions<Q, V, E, never>;
  /**
   * Bind one child to the exact pending call. Reacquisition checks program/input;
   * callers must use the same type contract for that program. Reacquisition returns
   * a fresh handle to the same stored child and retains its original result projection within that open assembly.
   * This is trusted local assembly, not wire validation. Child creation and ownership
   * publish together; child completion atomically settles the parent in the same tree.
   */
  ensureChild<C, CQ, CV, CE, CS = unknown>(
    requestId: string,
    options: MemoryChildOptions<C, V, E>,
  ): Operation<MemoryOwnedChild<C, CQ, CV, CE, CS>, never>;
}

/** The child journal is driven with ordinary recovery/hosting, without a handler attempt for the call. */
export interface MemoryOwnedChild<R, Q, V, E, S = unknown> {
  readonly link: ChildLink;
  readonly journal: MemoryJournal<R, Q, V, E, S>;
}

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
  open(): MemoryJournal<R, Q, V, E, S>;
}
