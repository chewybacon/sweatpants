import type {
  Outcome,
  Operation as IterableOperation,
  Work,
} from "@sweatpants/standard-durability";
export type {
  Outcome,
  Operation as IterableOperation,
  Work,
} from "@sweatpants/standard-durability";

export function success<T>(value: T): Outcome<T, never> {
  return { ok: true, value };
}
export function failure<E>(error: E): Outcome<never, E> {
  return { ok: false, error };
}

/** Structural HKT contract. Native type lambdas can satisfy it without core importing them. */
export interface RuntimeType {
  readonly In: unknown;
  readonly Out2: unknown;
  readonly Out1: unknown;
  readonly Target: unknown;
  readonly type: unknown;
}

/** Apply concrete slots, preserving domain-friendly success/error/requirements ordering. */
export type Computation<F extends RuntimeType, A, E = never, R = never> = (F & {
  readonly In: never;
  readonly Out2: R;
  readonly Out1: E;
  readonly Target: A;
})["type"];

/** One synchronous guest turn. Exceptions escape; suspension does not imply durable acceptance. */
export type Turn<T, Request> =
  | { readonly kind: "suspended"; readonly request: Request }
  | { readonly kind: "completed"; readonly value: T };

/** Interpret a guest request using the host's native yielded protocol. */
export type Handler<Request, Yielded, Reply = unknown> = (
  request: Request,
) => IterableOperation<Reply, Yielded>;

/** Structural middleware contract independent of domain arguments and runtime. */
export type Middleware<Args extends unknown[], Computed> = (
  args: Args,
  next: (...args: Args) => Computed,
) => Computed;

/** Wrap request handling while preserving the reply type (including explicit Outcome replies). */
export type HandlerMiddleware<Request, Yielded, Reply = unknown> = Middleware<
  [Request],
  IterableOperation<Reply, Yielded>
>;

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
  sleep(milliseconds: number): IterableOperation<void, Yielded>;
  /** Starts every child, returns values in input order, owns/cancels all children. */
  all<T>(work: readonly Work<T, Yielded>[]): IterableOperation<readonly T[], Yielded>;
  /** Release runs once after successful acquisition, including on failure/cancellation. */
  using<Resource, T>(
    acquire: Work<Resource, Yielded>,
    use: (resource: Resource) => IterableOperation<T, Yielded>,
    release: (resource: Resource) => IterableOperation<void, Yielded>,
  ): IterableOperation<T, Yielded>;
  /** JS integration boundary. Cancellation aborts signal; rejection is a native failure. */
  fromPromise<T>(start: (signal: AbortSignal) => Promise<T>): IterableOperation<T, Yielded>;
  /** The host boundary. Shared workflows themselves remain iterator-based. */
  start<T>(work: Work<T, Yielded>): RuntimeExecution<T>;
}

/** Operation-backed native cursor. Each activation acquires one fresh cursor. */
export interface Guest<T, Request, Y, Value = unknown, Error = unknown> {
  start(): IterableOperation<Turn<T, Request>, Y>;
  resume(outcome: Outcome<Value, Error>): IterableOperation<Turn<T, Request>, Y>;
  /** Idempotent resource disposal, without logical cancellation. */
  close(): IterableOperation<void, Y>;
}

export type GuestWork<T, Request, Y, Value = unknown, Error = unknown> = Work<
  Guest<T, Request, Y, Value, Error>,
  Y
>;
