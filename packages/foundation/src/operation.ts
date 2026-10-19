import type { Api, Around, Middleware, Operation } from "effection";

/** Construction-time Effection middleware. The first entry is outermost. */
export type OperationMiddleware<Operations> = Partial<Around<Operations>>;

/** Metadata stays on the driver; only the named operations are decorated. */
export interface OperationOptions<Driver, Operations = Driver> {
  readonly driver: Driver;
  readonly middleware?: readonly OperationMiddleware<Operations>[];
}

/** Preserve the caller's scope and resource lifetime; never capture a Scope. */
export function composeOperation<Args extends unknown[], Result>(
  operation: (...args: Args) => Operation<Result>,
  middleware: readonly (Middleware<Args, Operation<Result>> | undefined)[],
): (...args: Args) => Operation<Result> {
  return middleware.reduceRight(
    (next, around) => (around ? (...args) => around(args, next) : next),
    operation,
  );
}

/** Install the same middleware shape into an existing scoped Effection API. */
export function* installOperationMiddleware<ApiShape>(
  api: Pick<Api<ApiShape>, "around">,
  middleware: readonly OperationMiddleware<ApiShape>[],
): Operation<void> {
  for (const item of middleware) {
    yield* api.around(item);
  }
}
