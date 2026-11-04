import type { Decorator } from "./contracts.ts";

/** Decorate one callable. First layer is outermost; no scope or owner is created. */
export function composeOperation<F extends (...args: never[]) => unknown>(
  operation: F,
  middleware: readonly (Decorator<F> | undefined)[],
): F {
  return middleware.reduceRight((next, decorate) => (decorate ? decorate(next) : next), operation);
}
