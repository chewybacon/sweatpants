import { Effect } from "effect";
import type { Runtime, Work, RuntimeType } from "@sweatpants/foundation/computation";

export interface EffectRuntime extends RuntimeType {
  readonly type: Effect.Effect<this["Target"], this["Out1"], this["Out2"]>;
}

export type EffectYield<R = never> = Effect.Effect<unknown, never, R>;
export type Provide<R> = <T>(work: Effect.Effect<T, never, R>) => Effect.Effect<T>;

/** Configure native dependencies once at the host boundary. */
export function createRuntime<R>(provide: Provide<R>): Runtime<EffectYield<R>> {
  const execute = <T>(work: Work<T, EffectYield<R>>) =>
    Effect.gen(function* () {
      return yield* work();
    });
  return {
    version: 1,
    name: "Effect",
    sleep: (milliseconds) => Effect.sleep(milliseconds),
    all: (work) => Effect.all(work.map(execute), { concurrency: "unbounded" }),
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
