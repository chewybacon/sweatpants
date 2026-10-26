/** Portable composition contracts. No runtime imports or native scheduler types. */
export interface Operation<T, Y> {
  [Symbol.iterator](): Iterator<Y, T, unknown>;
}
export type Work<T, Y> = () => Operation<T, Y>;

/** Interpret a request using the host's yielded protocol. No persistence is implied. */
export type Handler<Request, Y, Reply = unknown> = (request: Request) => Operation<Reply, Y>;

/** An object exposing the same request/reply computation contract. */
export interface Dispatcher<Request, Y, Reply = unknown> {
  dispatch: Handler<Request, Y, Reply>;
}

/** A signature describes arguments and the eventual value, without a runtime. */
export type Operations<Signature, Y> = {
  readonly [K in keyof Signature]: Signature[K] extends (...args: infer Args) => infer Value
    ? (...args: Args) => Operation<Value, Y>
    : never;
};

export type Middleware<Signature, Y> = {
  readonly [K in keyof Signature]?: Signature[K] extends (...args: infer Args) => infer Value
    ? (args: Args, next: (...args: Args) => Operation<Value, Y>) => Operation<Value, Y>
    : never;
};

export interface Api<Signature, Y> {
  /** Resolve against the executing scope; obtaining this facade captures no scope. */
  readonly operations: Operations<Signature, Y>;
  /** Scoped middleware. Default/max surrounds min (terminal driver) middleware. */
  around(
    middleware: Middleware<Signature, Y>,
    options?: { readonly at: "min" | "max" },
  ): Operation<void, Y>;
  /** One terminal driver per scope; a child can install an override. */
  install(driver: Operations<Signature, Y>): Operation<void, Y>;
}

export interface Context<T, Y> {
  get(): Operation<T | undefined, Y>;
  expect(): Operation<T, Y>;
  /** Set on the executing scope. Inherited lookup does not mutate the parent. */
  set(value: T): Operation<void, Y>;
}

/** Effection-shaped composition. Implementations own the yielded protocol. */
export interface Composition<Y> {
  createApi<Signature extends object>(
    name: string,
    defaults: Operations<Signature, Y>,
  ): Api<Signature, Y>;
  createContext<T>(name: string): Context<T, Y>;
  /** A child owner that joins cleanup before returning. Plain yield* adds no scope. */
  scoped<T>(work: Work<T, Y>): Operation<T, Y>;
  /** Register cleanup in the executing scope; no separate child lifetime. */
  ensure(cleanup: Work<void, Y>): Operation<void, Y>;
}
