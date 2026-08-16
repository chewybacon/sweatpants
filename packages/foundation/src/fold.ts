/**
 * Applicative folds for indexed derivations.
 *
 * Several indexes computed from the same items do not feed each other, so
 * expressing them as sequential stages would trade one traversal for N.
 * Independent-and-combinable is applicative: a `Fold` owns its accumulator in
 * a closure, so folds with different accumulator types combine into a single
 * fold that produces every result in one pass.
 *
 * A cross-fold dependency does NOT require a second pass. `done()` observes
 * every accumulator, so joining one fold's result against another's is
 * {@link mapFold} over a combined fold. A second traversal of the source is
 * required only when a phase must re-read items with knowledge derived from
 * them.
 *
 * The tradeoff: resolving in `done()` buffers intermediate data rather than
 * re-reading the source. That is memory traded for passes, and is only
 * appropriate where the input is bounded.
 */

export interface FoldStep<In, Out> {
  step(item: In): void;
  done(): Out;
}

/**
 * A fold whose accumulator is hidden in a closure, so folds of differing
 * accumulator types combine with no existential and no cast at the call site.
 */
export interface Fold<In, Out> {
  start(): FoldStep<In, Out>;
}

export function fold<In, Out>(start: () => FoldStep<In, Out>): Fold<In, Out> {
  return { start };
}

export class FoldError extends Error {
  constructor(
    readonly foldKey: string,
    readonly reason: unknown,
  ) {
    super(`fold "${foldKey}" failed: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "FoldError";
  }
}

type OutputOf<In, F extends Fold<In, unknown>> = F extends Fold<In, infer Out> ? Out : never;

/**
 * Combine named folds into one. The result runs every member against each item
 * exactly once, so N indexes cost one traversal instead of N. A member failure
 * is attributed to its key.
 */
export function combine<In, S extends Record<string, Fold<In, unknown>>>(
  folds: S,
): Fold<In, { readonly [K in keyof S]: OutputOf<In, S[K]> }> {
  return fold(() => {
    const members = Object.entries(folds).map(([key, member]) => [key, member.start()] as const);
    return {
      step(item) {
        for (const [key, member] of members) {
          try {
            member.step(item);
          } catch (error) {
            throw new FoldError(key, error);
          }
        }
      },
      done() {
        const output: Record<string, unknown> = {};
        for (const [key, member] of members) {
          output[key] = member.done();
        }
        return output as { readonly [K in keyof S]: OutputOf<In, S[K]> };
      },
    };
  });
}

/** Post-process a fold's result once its accumulator is complete. */
export function mapFold<In, A, B>(source: Fold<In, A>, project: (value: A) => B): Fold<In, B> {
  return fold(() => {
    const stepper = source.start();
    return {
      step: (item) => stepper.step(item),
      done: () => project(stepper.done()),
    };
  });
}

/** Do work only for admitted items; the traversal itself is still shared. */
export function prefilter<In, Narrowed extends In, Out>(
  admits: (item: In) => item is Narrowed,
  source: Fold<Narrowed, Out>,
): Fold<In, Out> {
  return fold(() => {
    const stepper = source.start();
    return {
      step(item) {
        if (admits(item)) stepper.step(item);
      },
      done: () => stepper.done(),
    };
  });
}

export function runFold<In, Out>(target: Fold<In, Out>, items: Iterable<In>): Out {
  const stepper = target.start();
  for (const item of items) {
    stepper.step(item);
  }
  return stepper.done();
}
