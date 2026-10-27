import {
  all,
  race,
  action,
  call,
  ensure,
  resource,
  run,
  scoped,
  sleep,
  useAbortSignal,
  type Operation,
} from "effection";
import type { Runtime, Work } from "@sweatpan.ts/runtime";
import { effection } from "@standard-durability/effection";
import type { EffectionYield } from "./contracts.ts";

/** Install native scoped drivers before the portable workflow starts. */
export function createRuntime(
  install: () => Operation<void> = function* () {},
): Runtime<EffectionYield> {
  return {
    version: 1,
    name: "Effection",
    composition: effection,
    sleep,
    *all(work) {
      // call defers each work factory until its child is executing; scoped bounds
      // resources retained by children even when all completes successfully.
      return yield* scoped(() => all(work.map((child) => call(child))));
    },
    *using<Resource, T>(
      acquire: Work<Resource, EffectionYield>,
      use: (value: Resource) => Operation<T>,
      release: (value: Resource) => Operation<void>,
    ) {
      return yield* scoped(function* () {
        const acquired = yield* resource<Resource>(function* (provide) {
          const value = yield* acquire();
          yield* ensure(() => release(value));
          yield* provide(value);
        });
        return yield* use(acquired);
      });
    },
    *withSignal(signal, work) {
      signal.throwIfAborted();
      return yield* scoped(() =>
        race([
          call(work),
          action<never>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              abort();
            }
            return () => signal.removeEventListener("abort", abort);
          }),
        ]),
      );
    },
    *fromPromise(start) {
      const signal = yield* useAbortSignal();
      return yield* call(() => start(signal));
    },
    start(work) {
      const task = run(function* () {
        yield* install();
        return yield* work();
      });
      const result = Promise.resolve(task);
      let cancelling: Promise<void> | undefined;
      return {
        result,
        cancel() {
          return (cancelling ??= (async () => {
            // Observe result before requesting halt: cleanup can reject both.
            await Promise.allSettled([result, Promise.resolve().then(() => task.halt())]);
          })());
        },
      };
    },
  };
}

export const runtime = createRuntime();
