/** Design scaffold, not a published standard. This module has no runtime imports.
 * These two structural types mirror foundation/computation; a future extraction
 * must give production and this contract one source, rather than maintain copies.
 */
export interface Operation<T, Y> {
  [Symbol.iterator](): Iterator<Y, T, unknown>;
}
export type Work<T, Y> = () => Operation<T, Y>;

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
