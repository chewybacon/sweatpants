import { inProcess } from "@sweatpants/agent-host/server";
import { describe, expect, expectTypeOf, it } from "vitest";
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
import { createDurableTool, createToolEffects, type JournalRequest } from "@sweatpants/agent-sdk";
import { success, type GuestWork } from "@sweatpants/foundation/computation";
import { activateJournal } from "@sweatpants/primitive-journal";
import { SqliteJournal } from "@sweatpants/primitive-journal/sqlite";
import { createToolGuest } from "@sweatpants/tool-session/execution/tool-guest";
import { z } from "zod";
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
    it("runs an inferred compiled tool through caller-owned native capabilities", async () => {
      const tool = createDurableTool("double", { version: "1" })
        .description("Double through a portable capability")
        .parameters(z.object({ value: z.number() }))
        .effects({
          double: {
            version: "1",
            input: z.number(),
            output: z.number(),
            retrySafety: { mode: "repeatable" },
          },
        })
        .execute(function* (input, ctx) {
          return { value: yield* ctx.effect("double", input.value) };
        });
      const trace: string[] = [];
      const Effects = createToolEffects(c);
      const handlers = Effects.handlers([tool])({
        *"double.double"(input) {
          yield* c.ensure(function* () {
            trace.push("closed");
          });
          yield* host.wait(Promise.resolve());
          trace.push("handled");
          return success(input * 2);
        },
      });
      const journal = new SqliteJournal(":memory:", {
        executionId: "double",
        program: { id: "double", version: "1", digest: "double-v1" },
        input: { value: 21 },
      });
      try {
        const result = await host.start(() =>
          Effects.withEffects(
            [tool],
            {
              *effect(request) {
                return yield* handlers[`${request.tool}.${request.key}`]!(request.input);
              },
            },
            () =>
              activateJournal(
                inProcess().prepare(tool, "double").guest({ value: 21 }, "call"),
                journal,
                {
                  classify: () => "repeatable",
                  *handler(request) {
                    if (request.kind !== "effect") {
                      throw new Error("Unexpected capability");
                    }
                    return yield* Effects.operations.effect(request);
                  },
                },
              ),
          ),
        ).result;
        expect(result).toEqual({ state: "completed", value: { value: 42 } });
      } finally {
        journal.close();
      }
      expect(trace).toEqual(["handled", "closed"]);
    });

    it("preserves an unannotated result through lazy acquisition, suspension and journal replay", async () => {
      const trace: string[] = [];
      const tool = createDurableTool("inferred-result", { version: "1" })
        .description("Infer a result across two correlated operations")
        .parameters(z.object({ suspend: z.boolean() }))
        .effects({
          count: {
            version: "1",
            input: z.object({ text: z.string() }),
            output: z.number(),
            retrySafety: { mode: "repeatable" },
          },
          label: {
            version: "1",
            input: z.object({ count: z.number() }),
            output: z.string(),
            retrySafety: { mode: "repeatable" },
          },
        })
        .execute(function* ({ suspend }, ctx) {
          trace.push("body");
          const count = suspend ? yield* ctx.effect("count", { text: "hello" }) : 5;
          expectTypeOf(count).toEqualTypeOf<number>();
          const label = suspend ? yield* ctx.effect("label", { count }) : "five";
          expectTypeOf(label).toEqualTypeOf<string>();
          // Type-only probes do not execute a capability.
          // @ts-expect-error the count declaration does not accept the label operation's input
          void ctx.effect("count", { count: 5 });
          // @ts-expect-error replies retain the selected declaration's type
          const crossed: number = label;
          void crossed;
          trace.push("completed");
          return { count, label };
        });
      for (const suspend of [false, true]) {
        trace.length = 0;
        const prepared = inProcess().prepare(tool, "typed");
        const acquire = prepared.guest({ suspend }, "call");
        expect(trace).toEqual([]);
        // @ts-expect-error concrete preparation retains the authored input schema
        void prepared.guest({ suspend: "yes" }, "invalid");
        // Check conformance without annotating/widening the inferred work itself.
        acquire satisfies GuestWork<{ count: number; label: string }, JournalRequest, never>;
        const result = await host.start(function* () {
          const guest = yield* acquire();
          expect(trace).toEqual([]);
          try {
            let turn = yield* guest.start();
            if (suspend) {
              expect(turn.kind).toBe("suspended");
              expect(trace).toEqual(["body"]);
              turn = yield* guest.resume(success(5));
              expect(turn.kind).toBe("suspended");
              expect(trace).toEqual(["body"]);
              turn = yield* guest.resume(success("five"));
            }
            if (turn.kind !== "completed") {
              throw new Error("Expected completion");
            }
            expectTypeOf(turn.value).toEqualTypeOf<{ count: number; label: string }>();
            expectTypeOf(turn.value.count).toEqualTypeOf<number>();
            expectTypeOf(turn.value.label).toEqualTypeOf<string>();
            // @ts-expect-error the inferred result has no unrelated field
            void turn.value.missing;
            return turn.value;
          } finally {
            yield* guest.close();
          }
        }).result;
        expect(result).toEqual({ count: 5, label: "five" });
        expect(trace).toEqual(["body", "completed"]);

        const journal = new SqliteJournal(":memory:", {
          executionId: "inferred-result",
          program: { id: "inferred-result", version: "1", digest: "inferred-result-v1" },
          input: { suspend },
        });
        try {
          let activation = await host.start(() => activateJournal(acquire, journal)).result;
          if (suspend) {
            expect(activation.state).toBe("parked");
            if (activation.state !== "parked") {
              throw new Error("Expected count suspension");
            }
            journal.acceptRequest(activation.request.id, success(5));
            activation = await host.start(() => activateJournal(acquire, journal)).result;
            if (activation.state !== "parked") {
              throw new Error("Expected label suspension");
            }
            journal.acceptRequest(activation.request.id, success("five"));
            activation = await host.start(() => activateJournal(acquire, journal)).result;
          }
          if (activation.state !== "completed") {
            throw new Error("Expected journal completion");
          }
          expectTypeOf(activation.value.count).toEqualTypeOf<number>();
          expectTypeOf(activation.value.label).toEqualTypeOf<string>();
          // @ts-expect-error activation preserves the concrete authored result
          void activation.value.missing;
          expect(activation.value).toEqual(result);
        } finally {
          journal.close();
        }
      }
      // Chat admission's completion envelope also retains the concrete success type.
      await host.start(function* () {
        const guest = createToolGuest(tool, { suspend: false }, "chat-call");
        try {
          const turn = yield* guest.start();
          if (turn.kind !== "completed" || !turn.value.ok) {
            throw new Error("Expected successful chat completion");
          }
          expectTypeOf(turn.value.value.count).toEqualTypeOf<number>();
          expectTypeOf(turn.value.value.label).toEqualTypeOf<string>();
          expect(turn.value.value).toEqual({ count: 5, label: "five" });
        } finally {
          yield* guest.close();
        }
      }).result;
    });

    it("preserves raw parameter input and transforms an optional output once through placement", async () => {
      let inputs = 0;
      let outputs = 0;
      const tool = createDurableTool("transformed-placement", { version: "1" })
        .description("Transform at the authored boundary")
        .parameters(
          z.object({
            value: z.string().transform((raw) => {
              inputs++;
              return Number(raw);
            }),
          }),
          { outputProjection: { type: "object", properties: { value: { type: "number" } } } },
        )
        .output(
          z.string().transform((raw) => {
            outputs++;
            return Number(raw);
          }),
          { outputProjection: { type: "number" } },
        )
        .execute(function* ({ value }) {
          return String(value * 2);
        });
      const prepared = inProcess().prepare(tool, "typed");
      // @ts-expect-error callers supply schema input, not the transformed value
      void prepared.guest({ value: 21 }, "invalid");
      const work = prepared.guest({ value: "21" }, "call");
      expect([inputs, outputs]).toEqual([0, 0]);
      await host.start(function* () {
        const guest = yield* work();
        expect([inputs, outputs]).toEqual([0, 0]);
        try {
          const turn = yield* guest.start();
          if (turn.kind !== "completed") {
            throw new Error("Expected completion");
          }
          expectTypeOf(turn.value).toEqualTypeOf<number>();
          expect(turn.value).toBe(42);
          expect([inputs, outputs]).toEqual([1, 1]);
        } finally {
          yield* guest.close();
        }
      }).result;
    });

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
