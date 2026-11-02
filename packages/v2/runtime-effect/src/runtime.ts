import { Effect } from "effect";
import { effect, effectProgram, execute } from "@standard-durability/effect";
import { createStreams } from "@sweatpan.ts/runtime";
import type { Runtime, Work } from "@sweatpan.ts/runtime";
import type { EffectYield } from "./contracts.ts";

/** Establish composition bindings once at each root execution. */
export function createRuntime(
  install: Work<void, EffectYield> = function* () {},
): Runtime<EffectYield> {
  const fromPromise: Runtime<EffectYield>["fromPromise"] = (start) => Effect.promise(start);
  return {
    ...createStreams({ composition: effect, fromPromise }),
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
        Effect.flatMap(
          Effect.acquireRelease(execute(acquire), (resource) => execute(() => release(resource)), {
            interruptible: true,
          }),
          (resource) => execute(() => use(resource)),
        ),
      ),
    withSignal: (signal, work) =>
      effect.scoped(() =>
        Effect.suspend(() => {
          if (signal.aborted) {
            return Effect.die(signal.reason);
          }
          const interrupted = Effect.callback<never>((resume) => {
            const abort = () => resume(Effect.die(signal.reason));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              abort();
            }
            return Effect.sync(() => signal.removeEventListener("abort", abort));
          });
          return Effect.raceFirst(execute(work), interrupted);
        }),
      ),
    fromPromise,
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
            const settled = result.catch(() => undefined);
            controller.abort();
            await settled;
          })());
        },
      };
    },
  };
}

export const runtime = createRuntime();
