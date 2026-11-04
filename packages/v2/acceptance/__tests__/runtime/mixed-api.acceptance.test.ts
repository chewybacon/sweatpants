import { describe, expect, it } from "vitest";
import type { Operation } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createLatch } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  describe(`${runtime.name}: grouped scoped API`, () => {
    it("acquires ordinary calls and lazy properties while retaining live policy in its scope", async () => {
      let reads = 0;
      let version = "v1";
      const sync = {
        get version() {
          reads++;
          return version;
        },
        prefix: "root",
        labels: ["one", "two"],
        empty: null,
        missing: undefined,
        format(value: string) {
          return `${this.prefix}:${value}`;
        },
        echo<T>(value: T): T {
          return value;
        },
      };
      const api = runtime.composition.createApi("mixed", {
        sync,
        operations: {
          *fetch(value: string): Operation<string, Y> {
            yield* runtime.sleep(0);
            return `fetched:${value}`;
          },
        },
      });
      expect(reads).toBe(0);
      let escaped: Readonly<typeof sync> | undefined;
      await runtime.start(function* () {
        const access = yield* api;
        escaped = access;
        expect(access.format("value")).toBe("root:value");
        expect(access.version).toBe("v1");
        version = "v2";
        expect(access.version).toBe("v2");
        expect(reads).toBe(2);
        expect(access.labels).toEqual(["one", "two"]);
        expect(access.empty).toBeNull();
        expect(access.missing).toBeUndefined();
        yield* api.around({
          sync: {
            format: (next) => (value) => next(value.toUpperCase()),
            version: (next) => () => `${next()}!`,
            echo: (next) =>
              function <T>(value: T): T {
                return next(value);
              },
          },
          operations: {
            fetch: (next) =>
              function* (value) {
                return `${yield* next(value)}!`;
              },
          },
        });
        expect(access.echo("literal")).toBe("literal");
        expect(access.format("value")).toBe("root:VALUE");
        expect(access.version).toBe("v2!");
        expect(yield* api.operations.fetch("value")).toBe("fetched:value!");
        const driver = { ...sync, prefix: "installed" };
        yield* api.install({ sync: driver });
        expect(access.format("value")).toBe("installed:VALUE");
        yield* runtime.composition.scoped(function* () {
          yield* api.install({ sync: { ...driver, prefix: "child" } });
          const child = yield* api;
          expect(child.format("value")).toBe("child:VALUE");
          expect(access.format("value")).toBe("installed:VALUE");
          yield* api.around({
            sync: {
              format:
                (next) =>
                (...args) => {
                  expect(access.format("nested")).toBe("installed:NESTED");
                  return next(...args);
                },
            },
          });
          expect(child.format("value")).toBe("child:VALUE");
        });
        expect(access.format("value")).toBe("installed:VALUE");
      }).result;
      expect(() => escaped!.format("late")).toThrow("API access scope is closed");
      expect(() => escaped!.version).toThrow("API access scope is closed");
      await runtime.start(function* () {
        const access = yield* api;
        expect(access.format("fresh")).toBe("root:fresh");
      }).result;
    });

    it("orders property and method decorators and supports short circuits", async () => {
      const api = runtime.composition.createApi("mixed-order", {
        sync: { count: 3, call: (value: number) => value },
      });
      const trace: string[] = [];
      await runtime.start(function* () {
        for (const [label, at] of [
          ["max1", "max"],
          ["min1", "min"],
          ["max2", "max"],
          ["min2", "min"],
        ] as const) {
          yield* api.around(
            {
              sync: {
                call: (next) => (value) => {
                  trace.push(label);
                  return next(value) + 1;
                },
                count: (next) => () => {
                  const value = next();
                  trace.push(label);
                  return value + 1;
                },
              },
            },
            { at },
          );
        }
        yield* api.install({ sync: { count: 4, call: (value) => value * 2 } });
        const access = yield* api;
        expect(access.call(3)).toBe(10);
        expect(trace).toEqual(["max1", "max2", "min2", "min1"]);
        trace.length = 0;
        expect(access.count).toBe(8);
        expect(trace).toEqual(["min1", "min2", "max2", "max1"]);
        yield* api.around({ sync: { call: () => () => 20 } }, { at: "min" });
        expect(access.call(99)).toBe(22);
      }).result;
    });

    it("rejects asynchronous void decorators and operation-shaped property results", async () => {
      const api = runtime.composition.createApi("sync-errors", {
        sync: { label: "value", write(): void {} },
      });
      await runtime.start(function* () {
        yield* api.around({
          sync: {
            write: (next) => async () => {
              next();
            },
            label: () => () => runtime.sleep(0) as unknown as string,
          },
        });
        const access = yield* api;
        expect(() => access.write()).toThrow("returned a Promise");
        expect(() => access.label).toThrow("returned an operation");
      }).result;
    });

    it("keeps internal groups separate from public names and accepts throwing defaults and iterable data", async () => {
      const api = runtime.composition.createApi("x", {
        sync: {
          call: () => "sync",
          bytes: () => new Uint8Array([1, 2]),
          fail(): never {
            throw new Error("expected failure");
          },
        },
      });
      const other = runtime.composition.createApi("x:synchronous", {
        operations: {
          *call(): Operation<string, Y> {
            return "operation";
          },
        },
      });
      await runtime.start(function* () {
        yield* other.around({
          operations: {
            call: (next) =>
              function* () {
                return `${yield* next()}!`;
              },
          },
        });
        const access = yield* api;
        expect(access.call()).toBe("sync");
        expect(access.bytes()).toEqual(new Uint8Array([1, 2]));
        expect(access.fail).toThrow("expected failure");
        expect(yield* other.operations.call()).toBe("operation!");
      }).result;
    });

    it("invalidates access in finalizer order", async () => {
      const api = runtime.composition.createApi("cleanup", { sync: { read: () => "ready" } });
      const trace: string[] = [];
      await runtime.start(function* () {
        let read: () => string;
        yield* runtime.composition.ensure(function* () {
          expect(read).toThrow("API access scope is closed");
          trace.push("older");
        });
        ({ read } = yield* api);
        yield* runtime.composition.ensure(function* () {
          trace.push(read());
        });
      }).result;
      expect(trace).toEqual(["ready", "older"]);
    });

    it("invalidates retained callbacks on cancellation", async () => {
      const api = runtime.composition.createApi("access-cancel", { sync: { read: () => "ready" } });
      const ready = createLatch<() => string>();
      const parked = createLatch<void>();
      const execution = runtime.start(function* () {
        const access = yield* api;
        ready.resolve(access.read);
        yield* runtime.fromPromise(() => parked.promise);
      });
      void execution.result.catch(() => undefined);
      try {
        const read = await ready.promise;
        expect(read()).toBe("ready");
        await execution.cancel();
        expect(read).toThrow("API access scope is closed");
      } finally {
        parked.resolve();
        await execution.cancel();
      }
    });
  });
});
