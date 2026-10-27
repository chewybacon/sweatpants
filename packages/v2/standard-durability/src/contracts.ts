import type { StandardSchemaV1 } from "@standard-schema/spec";

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

export interface OperationDefinition<
  Input extends StandardSchemaV1,
  Success extends StandardSchemaV1,
  Failure extends StandardSchemaV1,
> {
  readonly input: Input;
  readonly success: Success;
  readonly failure: Failure;
  readonly version: string;
  readonly retrySafety: "repeatable" | "unsafe";
}
export type AnyOperation = OperationDefinition<
  StandardSchemaV1,
  StandardSchemaV1,
  StandardSchemaV1
>;
export type OperationDefinitions = Readonly<Record<string, AnyOperation>>;
export interface ApiDefinition<D extends OperationDefinitions> {
  readonly id: string;
  readonly operations: D;
}
export type InputOf<D extends AnyOperation> = StandardSchemaV1.InferInput<D["input"]>;
export type ProviderInputOf<D extends AnyOperation> = StandardSchemaV1.InferOutput<D["input"]>;
export type OutcomeOf<D extends AnyOperation> = Outcome<
  StandardSchemaV1.InferOutput<D["success"]>,
  StandardSchemaV1.InferOutput<D["failure"]>
>;
export type Signature<D extends OperationDefinitions> = {
  [K in keyof D]: (input: ProviderInputOf<D[K]>) => OutcomeOf<D[K]>;
};

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

/** A layer may delegate, rewrite, or return without calling next. Assembly owns policy. */
export type Middleware<Signature, Y> = {
  readonly [K in keyof Signature]?: Signature[K] extends (...args: infer Args) => infer Value
    ? (args: Args, next: (...args: Args) => Operation<Value, Y>) => Operation<Value, Y>
    : never;
};

export interface Api<Signature, Y> {
  /** Resolve against the executing scope; obtaining this facade captures no scope. */
  readonly operations: Operations<Signature, Y>;
  /**
   * Scoped middleware. Default/max surrounds min middleware. Earlier max layers
   * are outermost; later min layers are outermost within min. Child scopes inherit
   * layers. A short circuit deliberately skips the remainder of the chain.
   * Calling next in a child resolves its driver without redispatching wrappers.
   */
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

/**
 * Scoped composition. Native adapters own scheduling and the yielded protocol.
 * Hosts choose policy through assembly; interception applies to API facade calls,
 * not direct calls to implementation objects. Contexts may hold either deliberately.
 */
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
