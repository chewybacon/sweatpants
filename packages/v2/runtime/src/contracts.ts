import type { Composition, Operation, Work } from "@standard-durability/core";

/** One native execution and its physical resource lifetime. */
export interface RuntimeExecution<T> {
  /** Resolves only after all owned work and cleanup finish. */
  readonly result: Promise<T>;
  /**
   * Idempotent shutdown barrier: waits for execution and cleanup to settle.
   * Does not reject for execution/cleanup failure; observe result for the outcome.
   * This stops local execution. It does not record durable workflow cancellation,
   * unwind an authored Guest, or prove an external effect did not occur.
   */
  cancel(): Promise<void>;
}

/** Portable native scheduling and physical resource ownership. */
export interface Runtime<Yielded> {
  readonly name: string;
  readonly composition: Composition<Yielded>;
  sleep(milliseconds: number): Operation<void, Yielded>;
  /** Starts every child, returns values in input order, owns/cancels all children. */
  all<T>(work: readonly Work<T, Yielded>[]): Operation<readonly T[], Yielded>;
  /**
   * Acquisition is interruptible. After success, release is registered before use
   * and runs once on completion, failure or cancellation. Partial acquisition owns
   * its own cleanup. Native physical lifetime only, not durable cancellation.
   */
  using<Resource, T>(
    acquire: Work<Resource, Yielded>,
    use: (resource: Resource) => Operation<T, Yielded>,
    release: (resource: Resource) => Operation<void, Yielded>,
  ): Operation<T, Yielded>;
  /**
   * Run in an owned child scope. External abort fails this operation with the signal's
   * reason and joins native child cleanup; an already-aborted signal never starts work.
   * This is physical interruption only. Callers own durable cancellation policy.
   */
  withSignal<T>(signal: AbortSignal, work: Work<T, Yielded>): Operation<T, Yielded>;
  /** JS integration boundary. Cancellation aborts signal; rejection is a native failure. */
  fromPromise<T>(start: (signal: AbortSignal) => Promise<T>): Operation<T, Yielded>;
  /** The host boundary. Shared workflows themselves remain iterator-based. */
  start<T>(work: Work<T, Yielded>): RuntimeExecution<T>;
}
