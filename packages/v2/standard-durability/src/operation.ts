import type { Around } from "./contracts.ts";

/**
 * Decorate one callable. First layer is outermost; construction executes no work.
 * No scope is captured or created. Bind receiver-dependent methods at the call site.
 */
export function composeOperation<Args extends unknown[], Returned>(
  operation: (...args: Args) => Returned,
  middleware: readonly (Around<Args, Returned> | undefined)[],
): (...args: Args) => Returned {
  return middleware.reduceRight(
    (next, around) => (around ? (...args) => around(args, next) : next),
    operation,
  );
}
