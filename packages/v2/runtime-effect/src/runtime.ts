import { Effect } from "effect";
import { effect, effectProgram, execute } from "@standard-durability/effect";
import type { Runtime, Work } from "@sweatpan.ts/runtime";
import type { EffectYield } from "./contracts.ts";

/** Establish composition bindings once at each root execution. */
export function createRuntime(
  install: Work<void, EffectYield> = function* () {},
): Runtime<EffectYield> {
  return {
    version: 1,
    name: "Effect",
    composition: effect,
    sleep: (milliseconds) => Effect.sleep(milliseconds),
    all: (work) =>
      Effect.all(
        work.map((child) => execute(() => effect.scoped(child))),
        {
          concurrency: "unbounded",
        },
      ),
    using: (acquire, use, release) =>
      effect.scoped(() =>
        Effect.acquireUseRelease(
          execute(acquire),
          (resource) => execute(() => use(resource)),
          (resource) => execute(() => release(resource)),
        ),
      ),
    fromPromise: (start) => Effect.promise(start),
    start(work) {
      const controller = new AbortController();
      const result = Effect.runPromise(
        effectProgram(function* () {
          yield* install();
          return yield* work();
        }),
        { signal: controller.signal },
      );
      let cancelling: Promise<void> | undefined;
      return {
        result,
        cancel() {
          return (cancelling ??= (async () => {
            controller.abort();
            await result.catch(() => undefined);
          })());
        },
      };
    },
  };
}

export const runtime = createRuntime();
