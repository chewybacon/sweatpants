import { describe, expect, it } from "vitest";
import { call, run, spawn } from "effection";
import { Effect, Fiber } from "effect";
import { effection, type EffectionYield } from "@sweatpants/standard-durability-effection";
import {
  effect,
  effectProgram,
  execute,
  type EffectYield,
} from "@sweatpants/standard-durability-effect";
import { createConversation } from "../../../experiments/standard-durability/conversation.ts";
import type { Composition, Operation, Operations, Work } from "@sweatpants/standard-durability";

interface Host<Y> {
  composition: Composition<Y>;
  start<T>(work: Work<T, Y>): { result: Promise<T>; cancel(): Promise<void> };
  wait<T>(promise: Promise<T>): Operation<T, Y>;
  fork<T>(work: Work<T, Y>): Operation<Work<T, Y>, Y>;
}
function gate<T = void>() {
  return Promise.withResolvers<T>();
}
function scenarios<Y>(name: string, host: Host<Y>) {
  const c = host.composition;
  describe(`standard durability composition: ${name}`, () => {
    it("authors one conversation with inherited middleware, child overrides and owned cleanup", async () => {
      const chat = createConversation(c);
      const trace: string[] = [];
      const result = await host.start(() =>
        chat.application(
          {
            *sample(prompt) {
              return `primary: ${prompt}`;
            },
            *countTokens(text) {
              return text.length;
            },
          },
          {
            *sample(prompt) {
              return `alternate: ${prompt}`;
            },
            *countTokens(text) {
              return text.length;
            },
          },
          (event) => trace.push(event),
        ),
      ).result;
      expect(result).toEqual([
        "primary: acme: Hello",
        "alternate: preview: Hello from the child",
        "primary: acme: Hello again",
      ]);
      expect(trace).toEqual([
        "sample:before",
        "sample:after",
        "sample:before",
        "sample:after",
        "child:closed",
        "sample:before",
        "sample:after",
        "application:closed",
      ]);
    });

    it("existing children see later parent bindings and middleware while siblings stay isolated", async () => {
      const context = c.createContext<string>("live:context");
      const api = c.createApi<{ read(): string }>("live:api", {
        *read() {
          return yield* context.expect();
        },
      });
      const ready = gate();
      const proceed = gate();
      const trace: string[] = [];
      const values = await host.start(function* () {
        yield* context.set("before");
        yield* api.around({
          *read(args, next) {
            trace.push("parent:in");
            const value = yield* next(...args);
            trace.push("parent:out");
            return value;
          },
        });
        const deferred = api.operations.read();
        const join = yield* host.fork(function* () {
          yield* api.around({
            *read(args, next) {
              trace.push("child:in");
              const value = yield* next(...args);
              trace.push("child:out");
              return value;
            },
          });
          ready.resolve();
          yield* host.wait(proceed.promise);
          return yield* deferred;
        });
        yield* host.wait(ready.promise);
        const sibling = yield* c.scoped(function* () {
          yield* context.set("sibling");
          return yield* context.expect();
        });
        yield* context.set("after");
        yield* api.around({
          *read(args, next) {
            trace.push("late:in");
            const value = yield* next(...args);
            trace.push("late:out");
            return value;
          },
        });
        proceed.resolve();
        return [yield* join(), sibling, yield* context.expect()];
      }).result;
      expect(values).toEqual(["after", "sibling", "after"]);
      expect(trace).toEqual([
        "parent:in",
        "late:in",
        "child:in",
        "child:out",
        "late:out",
        "parent:out",
      ]);
    });

    it("max wraps min middleware in the same order on both runtimes", async () => {
      const api = c.createApi<{ read(): string }>("ordering", {
        *read() {
          return "core";
        },
      });
      const result = await host.start(function* () {
        yield* api.around({
          *read(args, next) {
            return `max1(${yield* next(...args)})`;
          },
        });
        yield* api.around(
          {
            *read(args, next) {
              return `min1(${yield* next(...args)})`;
            },
          },
          { at: "min" },
        );
        yield* api.around({
          *read(args, next) {
            return `max2(${yield* next(...args)})`;
          },
        });
        yield* api.around(
          {
            *read(args, next) {
              return `min2(${yield* next(...args)})`;
            },
          },
          { at: "min" },
        );
        return yield* api.operations.read();
      }).result;
      expect(result).toBe("max1(max2(min2(min1(core))))");
    });

    it("keeps inherited middleware around child drivers and restores the parent core", async () => {
      const driver = (value: string): Operations<{ read(): string; helper(): string }, Y> => ({
        *read() {
          return yield* this.helper();
        },
        *helper() {
          return value;
        },
      });
      const api = c.createApi<{ read(): string; helper(): string }>(
        "driver-ordering",
        driver("default"),
      );
      const result = await host.start(function* () {
        yield* api.around(
          {
            *read(args, next) {
              return `max(${yield* next(...args)})`;
            },
          },
          { at: "max" },
        );
        yield* api.around(
          {
            *read(args, next) {
              return `min(${yield* next(...args)})`;
            },
          },
          { at: "min" },
        );
        yield* api.around({
          *read(args, next) {
            return `ordinary(${yield* next(...args)})`;
          },
        });
        const before = yield* api.operations.read();
        yield* api.install(driver("parent"));
        const child = yield* c.scoped(function* () {
          yield* api.install(driver("child"));
          return yield* api.operations.read();
        });
        const continuation = yield* c.scoped(function* () {
          yield* api.around({
            *read(args, next) {
              return yield* c.scoped(function* () {
                yield* api.install(driver("continuation"));
                return yield* next(...args);
              });
            },
          });
          return yield* api.operations.read();
        });
        return [before, child, continuation, yield* api.operations.read()];
      }).result;
      expect(result).toEqual([
        "max(ordinary(min(default)))",
        "max(ordinary(min(child)))",
        "max(ordinary(min(continuation)))",
        "max(ordinary(min(parent)))",
      ]);
    });

    it("fails visibly for missing context, missing driver and duplicate installation", async () => {
      const context = c.createContext<string>("required");
      await expect(host.start(() => context.expect()).result).rejects.toThrow();
      const api = c.createApi<{ read(): string }>("required:api", {
        *read() {
          throw new Error("Missing driver");
        },
      });
      await expect(host.start(() => api.operations.read()).result).rejects.toThrow(
        "Missing driver",
      );
      await expect(
        host.start(function* () {
          const driver = {
            *read() {
              return "ok";
            },
          };
          yield* api.install(driver);
          yield* api.install(driver);
        }).result,
      ).rejects.toThrow("Driver already installed");
    });

    it("awaits child and parent cleanup on cancellation, with context available in finalizers", async () => {
      const ready = gate();
      const cleanupStarted = gate();
      const release = gate();
      const trace: string[] = [];
      const context = c.createContext<string>("cleanup");
      const execution = host.start(function* () {
        yield* context.set("parent");
        yield* c.ensure(function* () {
          trace.push(yield* context.expect());
        });
        yield* host.fork(function* () {
          yield* context.set("child");
          yield* c.ensure(function* () {
            cleanupStarted.resolve();
            yield* host.wait(release.promise);
            trace.push(yield* context.expect());
          });
          ready.resolve();
          yield* host.wait(new Promise<never>(() => {}));
        });
        yield* host.wait(new Promise<never>(() => {}));
      });
      // Observe rejection before requesting cancellation to avoid an unhandled promise.
      const outcome = execution.result.then(
        () => "completed",
        () => "interrupted",
      );
      await ready.promise;
      let cancelled = false;
      const cancellation = execution.cancel().then(() => {
        cancelled = true;
      });
      try {
        await cleanupStarted.promise;
        expect(cancelled).toBe(false);
      } finally {
        release.resolve();
        await cancellation;
      }
      expect(await outcome).toBe("interrupted");
      expect(trace).toEqual(["child", "parent"]);
    });

    it("runs cleanup after a body failure and reports a failing finalizer", async () => {
      const trace: string[] = [];
      await expect(
        host.start(function* () {
          yield* c.ensure(function* () {
            trace.push("released");
          });
          throw new Error("body failed");
        }).result,
      ).rejects.toThrow("body failed");
      expect(trace).toEqual(["released"]);
      await expect(
        host.start(function* () {
          yield* c.ensure(function* () {
            throw new Error("cleanup failed");
          });
          return "body completed";
        }).result,
      ).rejects.toThrow("cleanup failed");
    });
  });
}
scenarios<EffectionYield>("Effection", {
  composition: effection,
  start(work) {
    const task = run(work);
    return {
      result: Promise.resolve(task),
      cancel: async () => {
        await task.halt();
      },
    };
  },
  *wait(promise) {
    return yield* call(() => promise);
  },
  *fork(work) {
    const task = yield* spawn(work);
    return () => task;
  },
});
scenarios<EffectYield>("Effect", {
  composition: effect,
  start(work) {
    const controller = new AbortController();
    const result = Effect.runPromise(effectProgram(work), { signal: controller.signal });
    return {
      result,
      cancel: async () => {
        controller.abort();
        await result.catch(() => undefined);
      },
    };
  },
  wait: (promise) => Effect.promise(() => promise),
  fork: (work) =>
    Effect.gen(function* () {
      // Native fork + an explicit composition scope: not an implicit fiber hook.
      const fiber = yield* Effect.forkScoped(execute(() => effect.scoped(work)));
      return () => Fiber.join(fiber);
    }),
});
