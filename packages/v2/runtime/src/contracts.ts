import type { Composition, Operation, Work } from "@standard-durability/core";

export interface RuntimeExecution<T> {
  /** Resolves only after all owned work and cleanup finish. */
  readonly result: Promise<T>;
  /** Idempotent. Requests cancellation and waits for completion, including cleanup. */
  cancel(): Promise<void>;
}

/** Experimental v1 capability contract, not a published interoperability standard. */
export interface Runtime<Yielded> {
  readonly version: 1;
  readonly name: string;
  readonly composition: Composition<Yielded>;
  sleep(milliseconds: number): Operation<void, Yielded>;
  /** Starts every child, returns values in input order, owns/cancels all children. */
  all<T>(work: readonly Work<T, Yielded>[]): Operation<readonly T[], Yielded>;
  /** Release runs once after successful acquisition, including on failure/cancellation. */
  using<Resource, T>(
    acquire: Work<Resource, Yielded>,
    use: (resource: Resource) => Operation<T, Yielded>,
    release: (resource: Resource) => Operation<void, Yielded>,
  ): Operation<T, Yielded>;
  /** JS integration boundary. Cancellation aborts signal; rejection is a native failure. */
  fromPromise<T>(start: (signal: AbortSignal) => Promise<T>): Operation<T, Yielded>;
  /** The host boundary. Shared workflows themselves remain iterator-based. */
  start<T>(work: Work<T, Yielded>): RuntimeExecution<T>;
}
