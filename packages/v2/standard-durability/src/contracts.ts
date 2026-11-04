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

/** Wrap the complete callable, preserving generic and overloaded signatures. */
export type Decorator<F> = (next: F) => F;
export type Around<Args extends unknown[], Returned> = Decorator<(...args: Args) => Returned>;
export type OperationMiddleware<Methods> = {
  readonly [K in keyof Methods]?: Decorator<NonNullable<Methods[K]>>;
};
export type Middleware<Shape, Y> = OperationMiddleware<Operations<Shape, Y>>;

/** Properties are decorated as zero-argument readers; methods retain their signature. */
export type SyncMiddleware<Members> = {
  readonly [K in keyof Members]?: Members[K] extends (...args: never[]) => unknown
    ? Decorator<Members[K]>
    : Decorator<() => Members[K]>;
};
export interface ApiMiddleware<O, S> {
  readonly operations?: OperationMiddleware<O>;
  readonly sync?: SyncMiddleware<S>;
}
export interface ApiDefinition<O, S> {
  readonly operations?: O;
  readonly sync?: S;
}
export type OperationMethods<O, Y> = {
  [K in keyof O]: (...args: never[]) => Operation<unknown, Y>;
};
// Ordinary iterable data is valid synchronously. Other iterable objects are reserved
// for runtime operations. Explicit groups determine dispatch; types validate them.
type IterableData =
  | string
  | readonly unknown[]
  | ReadonlyMap<unknown, unknown>
  | ReadonlySet<unknown>
  | ArrayBufferView;
type UnsupportedSync<T> = T extends IterableData
  ? never
  : T extends PromiseLike<unknown> | Operation<unknown, unknown>
    ? T
    : never;
type SynchronousMembers<S> = {
  [K in keyof S]: S[K] extends (...args: never[]) => infer R
    ? [UnsupportedSync<R>] extends [never]
      ? S[K]
      : never
    : [UnsupportedSync<S[K]>] extends [never]
      ? S[K]
      : never;
};

export type ApiDefaults<O, S> = ApiDefinition<O, S> & { readonly sync?: S & SynchronousMembers<S> };

/** One grouped API. Yield it to acquire synchronous access in the executing scope. */
export interface Api<O, Y, S = {}> extends Operation<Readonly<S>, Y> {
  readonly operations: O;
  /**
   * Earlier max decorators surround later max decorators; later min decorators
   * surround earlier min decorators. Operation next() resolves its terminal driver
   * in its executing scope. Synchronous access resolves in its acquired scope.
   */
  around(
    middleware: ApiMiddleware<O, S>,
    options?: { readonly at: "min" | "max" },
  ): Operation<void, Y>;
  /** One installation per scope. Omitted groups retain their currently selected driver. */
  install(driver: ApiDefinition<O, S>): Operation<void, Y>;
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
  /** Groups declare execution kind; both groups are optional. No implicit lifting. */
  createApi<O extends OperationMethods<O, Y> = {}, S extends object = {}>(
    name: string,
    defaults: ApiDefaults<O, S>,
  ): Api<O, Y, S>;
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
