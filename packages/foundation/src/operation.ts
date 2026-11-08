import type { Middleware, IterableOperation as Operation } from "./computation.ts";

/** Structural construction-time middleware. The first entry is outermost. */
export type OperationMiddleware<Operations> = {
  [K in keyof Operations]?: Operations[K] extends (...args: infer Args) => infer Result
    ? Middleware<Args, Result>
    : never;
};

/** Metadata stays on the driver; only the named operations are decorated. */
export interface OperationOptions<Driver, Operations = Driver> {
  readonly driver: Driver;
  readonly middleware?: readonly OperationMiddleware<Operations>[];
}

/** Preserve the caller's scope and resource lifetime; never capture a Scope. */
export function composeOperation<Args extends unknown[], Result>(
  operation: (...args: Args) => Result,
  middleware: readonly (Middleware<Args, Result> | undefined)[],
): (...args: Args) => Result {
  return middleware.reduceRight(
    (next, around) => (around ? (...args) => around(args, next) : next),
    operation,
  );
}

/** Install the same middleware shape into an existing scoped API. */
export function* installOperationMiddleware<ApiShape, Y>(
  api: { around(middleware: OperationMiddleware<ApiShape>): Operation<void, Y> },
  middleware: readonly OperationMiddleware<ApiShape>[],
): Operation<void, Y> {
  for (const item of middleware) {
    yield* api.around(item);
  }
}
