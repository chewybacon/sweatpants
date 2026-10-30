/** An iterable computation with a result and a yielded protocol, independent of a scheduler. */
export interface Operation<T, Y> {
  [Symbol.iterator](): Iterator<Y, T, unknown>;
}

/** Creates an operation. Constructing work does not itself advance the computation. */
export type Work<T, Y> = () => Operation<T, Y>;

/** Explicit success or failure data; native exceptions and cancellation remain separate. */
export type Outcome<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Interpret a request using the host's yielded protocol. No persistence is implied. */
export type Handler<Request, Y, Reply = unknown> = (request: Request) => Operation<Reply, Y>;

/** Explicit shorthand: lift a value signature into portable operation methods. */
export type Operations<Shape, Y> = {
  readonly [K in keyof Shape]: Shape[K] extends (...args: infer Args) => infer Value
    ? (...args: Args) => Operation<Value, Y>
    : never;
};

/** Effection-style interception of a callable's complete return type. */
export type Around<Args extends unknown[], Returned> = (
  args: Args,
  next: (...args: Args) => Returned,
) => Returned;

/**
 * Derive layers from actual operation methods, without wrapping their return again.
 * Per-call generic relationships and overloads require specifically typed hooks;
 * conditional extraction does not preserve them. Concrete capabilities retain types.
 */
export type OperationMiddleware<Methods> = {
  readonly [K in keyof Methods]?: Methods[K] extends (...args: infer Args) => infer Returned
    ? Around<Args, Returned>
    : never;
};

/** A layer may delegate, rewrite, or short-circuit. Assembly owns policy. */
export type Middleware<Shape, Y> = OperationMiddleware<Operations<Shape, Y>>;

export interface Api<Methods, Y> {
  /** Resolve against the executing scope; obtaining this facade captures no scope. */
  readonly operations: Methods;
  /**
   * Scoped middleware. Default/max surrounds min middleware. Earlier max layers
   * are outermost; later min layers are outermost within min. Child scopes inherit
   * layers. A short circuit deliberately skips the remainder of the chain.
   * Calling next in a child resolves its driver without redispatching wrappers.
   */
  around(
    middleware: OperationMiddleware<Methods>,
    options?: { readonly at: "min" | "max" },
  ): Operation<void, Y>;
  /** One terminal driver per scope; a child can install an override. */
  install(driver: Methods): Operation<void, Y>;
}

export interface Context<T, Y> {
  get(): Operation<T | undefined, Y>;
  expect(): Operation<T, Y>;
  /** Set on the executing scope. Inherited lookup does not mutate the parent. */
  set(value: T): Operation<void, Y>;
}

/**
 * Scoped composition. Native adapters own scheduling and the yielded protocol.
 * Hosts choose policy through assembly; interception applies to API facade calls,
 * not direct calls to implementation objects. Contexts may hold either deliberately.
 */
export interface Composition<Y> {
  /** Infer an operation-bearing implementation directly, including its result types. */
  createApi<Methods extends { [K in keyof Methods]: (...args: never[]) => Operation<unknown, Y> }>(
    name: string,
    defaults: Methods,
  ): Api<Methods, Y>;
  /** Explicit value signatures remain a shorthand for operation-bearing methods. */
  createApi<Signature extends object>(
    name: string,
    defaults: Operations<Signature, Y>,
  ): Api<Operations<Signature, Y>, Y>;
  createContext<T>(name: string): Context<T, Y>;
  /** A child owner that joins cleanup before returning. Plain yield* adds no scope. */
  scoped<T>(work: Work<T, Y>): Operation<T, Y>;
  /**
   * Recover a thrown error across native operation/API boundaries, without creating
   * a scope. Native interruption propagates without recovery. Runtime-specific
   * combined failures may also propagate without invoking the handler.
   */
  catchError<T, R>(
    work: Work<T, Y>,
    recover: (error: unknown) => Operation<R, Y>,
  ): Operation<T | R, Y>;
  /** Register cleanup in the executing scope; no separate child lifetime. */
  ensure(cleanup: Work<void, Y>): Operation<void, Y>;
}

/** Structural type lambda. Native adapters supply the computation representation. */
export interface RuntimeType {
  readonly In: unknown;
  readonly Out2: unknown;
  readonly Out1: unknown;
  readonly Target: unknown;
  readonly type: unknown;
}

/** Apply result, native error and dependency slots without importing a runtime. */
export type Computation<F extends RuntimeType, A, E = never, R = never> = (F & {
  readonly In: never;
  readonly Out2: R;
  readonly Out1: E;
  readonly Target: A;
})["type"];
