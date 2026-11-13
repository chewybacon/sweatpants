import type { Api, Composition, Operation, Work } from "@standard-durability/core";

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
export interface Runtime<Yielded> extends Streams<Yielded> {
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

/** One started execution, with independent event readers and a retained host result. */
export interface Attempt<Event, End, Y> {
  /** Observe this attempt without starting or stopping its producer. Retention,
   * offset validation and value isolation follow the supplied producer. */
  events(offset?: number): Stream<Event, void, Y>;
  /** Wait for the same execution and joined cleanup; repeated reads never execute
   * again. Original failures propagate here. Cancelling a waiter stops only its wait. */
  result(): Operation<End, Y>;
}

/** Fresh unstarted producer. Own event closure, disclosure and terminal protocol
 * projection; events must support independent readers without starting production. */
export interface AttemptProducer<Event, End, Y> {
  /** Execute once, joining command-owned resources before returning. */
  run(): Operation<End, Y>;
  /** Read retained events independently of production. */
  events(offset?: number): Stream<Event, void, Y>;
}

/** Acquisition-scope owner of native attempts. No admission, queue or retry policy. */
export interface Session<Input, Event, End, Y> {
  /** Construct and start one producer. Returning acknowledges attempt creation,
   * not durable input acceptance. Rejects after the acquisition scope exits.
   * Conflicting inputs must be rejected/serialized by the application. */
  send(input: Input): Operation<Attempt<Event, End, Y>, Y>;
}

/** Scoped subscription; one next operation at a time. Sources define pull/broadcast behavior. */
export interface Subscription<T, Close, Y> {
  /** Wait for the next value or completion. Rejects use after the subscribing scope exits. */
  next(): Operation<IteratorResult<T, Close>, Y>;
}

/** Subscription acquisition. next may advance computation or await independent production.
 * Implementations specify ownership, repeated subscription and delivery semantics. */
export interface Stream<T, Close, Y> extends Operation<Subscription<T, Close, Y>, Y> {}

/** Callback-facing broadcast producer. Does not wait for consumers. */
export interface Signal<T, Close, Y> extends Stream<T, Close, Y> {
  /** Send to every active subscription; drop when none exist. Safe as an unbound callback. */
  send(value: T): void;
  /** Complete current subscriptions after queued values. Future subscriptions are independent. */
  close(value: Close): void;
}

/** Operation-facing broadcast producer. Send is lazy, with no consumer acknowledgement. */
export interface Channel<T, Close, Y> extends Stream<T, Close, Y> {
  send(value: T): Operation<void, Y>;
  /** Complete current subscriptions after queued values; does not retain terminal state globally. */
  close(value: Close): Operation<void, Y>;
}

/** Live broadcast factories. Per-subscription queues are unbounded; nothing is journaled. */
export interface Streams<Y> {
  createSignal<T, Close = void>(): Signal<T, Close, Y>;
  createChannel<T, Close = void>(): Channel<T, Close, Y>;
}

/** Interceptable subscription operation; event delivery remains on the returned subscription. */
export interface StreamMethods<T, Close, Y> {
  /** Subscribe using the current scoped implementation and middleware. */
  subscribe(): Operation<Subscription<T, Close, Y>, Y>;
}

/** Ordinary scoped API with a consumer-only stream facade. No source is captured. */
export interface StreamApi<T, Close, Y> extends Api<StreamMethods<T, Close, Y>, Y> {
  /** Each subscription dispatches through operations.subscribe in its executing scope. */
  readonly stream: Stream<T, Close, Y>;
}

/** Retained callback stream. Values are held by reference until the buffer is released. */
export interface BufferedSignal<T, Close, Y> extends Signal<T, Close, Y> {
  /** Retain a value even with no readers. Throws after terminal; safe as an unbound callback. */
  send(value: T): void;
  /** Permanently complete after retained values, including for future readers. First terminal wins. */
  close(value: Close): void;
  /**
   * Read after this many values, starting at zero by default. Each subscription has
   * its own cursor. Rejects noninteger, negative and beyond-tail offsets when subscribed.
   * Readers drain retained values before observing retained completion or failure.
   * Optional pure compaction merges adjacent available values; undefined stops before
   * the next value. Never mutate inputs. No waiting for additional values to merge.
   * A compaction exception leaves the cursor unchanged. maxValues bounds source entries
   * consumed per frame (default 256); it must be a positive safe integer.
   */
  from(
    offset: number,
    compact?: (previous: T, next: T) => T | undefined,
    maxValues?: number,
  ): BufferedStream<T, Close, Y>;
  /** Retain a terminal failure for current and future readers. First terminal wins. */
  fail(error: unknown): void;
}

/** Buffered reader whose offset counts source values, not compacted frames. */
export interface BufferedSubscription<T, Close, Y> extends Subscription<T, Close, Y> {
  /** Resume after the values consumed by the last successful next(). */
  readonly offset: number;
}

/** Scoped buffered subscription with an observable source cursor. */
export interface BufferedStream<T, Close, Y> extends Operation<
  BufferedSubscription<T, Close, Y>,
  Y
> {}

/** Cleanup registration shared by native composition and Guest logical scopes.
 * Cleanup here only invalidates a local handle; source resources retain their own owners. */
export interface PullStreamScope<Y> {
  /** Register synchronous handle invalidation on owner exit. */
  ensure(cleanup: Work<void, never>): Operation<void, Y>;
}
