import { Effect } from "effect";
import type { Runtime, Work, RuntimeType } from "@sweatpants/foundation/computation";

export interface EffectRuntime extends RuntimeType {
  readonly type: Effect.Effect<this["Target"], this["Out1"], this["Out2"]>;
}

export type EffectYield<R = never> = Effect.Effect<unknown, never, R>;
export type Provide<R> = <T>(work: Effect.Effect<T, never, R>) => Effect.Effect<T>;

/** Run structural work and join generator finalizers on native failure or interruption. */
export function execute<T, R>(work: Work<T, EffectYield<R>>): Effect.Effect<T, never, R> {
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

/** Configure native dependencies once at the host boundary. */
export function createRuntime<R>(provide: Provide<R>): Runtime<EffectYield<R>> {
  return {
    version: 1,
    name: "Effect",
    sleep: (milliseconds) => Effect.sleep(milliseconds),
    all: (work) =>
      Effect.all(
        work.map((child) => execute(child)),
        { concurrency: "unbounded" },
      ),
    using: (acquire, use, release) =>
      Effect.acquireUseRelease(
        execute(acquire),
        (resource) => execute(() => use(resource)),
        (resource) => execute(() => release(resource)),
      ),
    // Promise failures are defects at this raw integration boundary. Domain adapters
    // should classify expected failures and return Outcome explicitly.
    fromPromise: (start) => Effect.promise(start),
    start(work) {
      const controller = new AbortController();
      const result = Effect.runPromise(provide(execute(work)), { signal: controller.signal });
      return {
        result,
        async cancel() {
          controller.abort();
          await result.catch(() => undefined);
        },
      };
    },
  };
}

export const runtime = createRuntime<never>((work) => work);
