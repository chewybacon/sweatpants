import { Effect } from "effect";
import type { Work } from "@standard-durability/core";

/**
 * Run structural work with best-effort iterator return on native failure/interruption.
 * A yielded cleanup failure stops this drain; registered native scope finalizers own
 * supported physical cleanup, rather than arbitrary yielding JavaScript finally blocks.
 */
export function executeWork<T, R>(
  work: Work<T, Effect.Effect<unknown, never, R>>,
): Effect.Effect<T, never, R> {
  return Effect.suspend(() => {
    const iterator = work()[Symbol.iterator]();
    let completed = false;
    return Effect.ensuring(
      Effect.gen(function* () {
        const value = yield* { [Symbol.iterator]: () => iterator };
        completed = true;
        return value;
      }),
      Effect.gen(function* () {
        if (!completed) {
          let step = iterator.return?.(undefined as never);
          while (step && !step.done) {
            const value = yield* step.value;
            step = iterator.next(value);
          }
        }
      }),
    );
  });
}
