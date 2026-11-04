import type { Runtime } from "@sweatpan.ts/runtime";
import type { Operations } from "@standard-durability/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  describe(`${runtime.name}: scoped protocol drivers and middleware`, () => {
    for (const driverFirst of [true, false]) {
      it(`keeps max/min interceptors around the installed driver (driver first: ${driverFirst})`, async () => {
        const peer = createProtocolRig();
        const trace: string[] = [];
        const api = runtime.composition.createApi<
          Operations<
            {
              read(id: string): string;
            },
            Y
          >
        >("ordering", {
          operations: {
            *read() {
              throw new Error("Missing driver");
            },
          },
        });
        const driver = {
          *read(id: string) {
            trace.push("driver");
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id, token: "driver" }, signal),
            );
            return reply.body;
          },
        };
        const execution = runtime.start(function* () {
          if (driverFirst) {
            yield* api.install({
              operations: driver,
            });
          }
          for (const [name, at] of [
            ["max1", "max"],
            ["min1", "min"],
            ["max2", "max"],
            ["min2", "min"],
          ] as const) {
            yield* api.around(
              {
                operations: {
                  read: (next) =>
                    function* (...args) {
                      expectTypeOf(args).toEqualTypeOf<[id: string]>();
                      trace.push(`${name}:in`);
                      const result = yield* next(...args);
                      expectTypeOf(result).toEqualTypeOf<string>();
                      trace.push(`${name}:out`);
                      return result;
                    },
                },
              },
              { at },
            );
          }
          if (!driverFirst) {
            yield* api.install({
              operations: driver,
            });
          }
          return yield* api.operations.read("read");
        });
        const result = execution.result;
        void result.catch(() => undefined);
        await peer.waitForRequests(1);
        peer.reply("read", { status: 200, body: "value" });
        expect(await result).toBe("value");
        expect(trace).toEqual([
          "max1:in",
          "max2:in",
          "min2:in",
          "min1:in",
          "driver",
          "min1:out",
          "min2:out",
          "max2:out",
          "max1:out",
        ]);
      });
    }
    it("resolves a deferred call under a child driver and restores parent interception", async () => {
      const peer = createProtocolRig();
      const trace: string[] = [];
      const api = runtime.composition.createApi<
        Operations<
          {
            read(id: string): string;
          },
          Y
        >
      >("deferred", {
        operations: {
          *read() {
            throw new Error("Missing driver");
          },
        },
      });
      const driver = (token: string) => ({
        *read(id: string) {
          const reply = yield* runtime.fromPromise((signal) => peer.send({ id, token }, signal));
          return reply.body;
        },
      });
      const execution = runtime.start(function* () {
        yield* api.install({
          operations: driver("parent"),
        });
        yield* api.around({
          operations: {
            read: (next) =>
              function* (...args) {
                trace.push("parent");
                return yield* next(...args);
              },
          },
        });
        const deferred = api.operations.read("child-call");
        const child = yield* runtime.composition.scoped(function* () {
          yield* api.install({
            operations: driver("child"),
          });
          yield* api.around({
            operations: {
              read: (next) =>
                function* (...args) {
                  trace.push("child");
                  return yield* next(...args);
                },
            },
          });
          return yield* deferred;
        });
        const parent = yield* api.operations.read("parent-call");
        return { child, parent };
      });
      void execution.result.catch(() => undefined);
      await peer.waitForRequests(1);
      expect(peer.requests[0]?.token).toBe("child");
      peer.reply("child-call", { status: 200, body: "child result" });
      await peer.waitForRequests(2);
      expect(peer.requests[1]?.token).toBe("parent");
      peer.reply("parent-call", { status: 200, body: "parent result" });
      expect(await execution.result).toEqual({ child: "child result", parent: "parent result" });
      expect(trace).toEqual(["parent", "child", "parent"]);
    });
    it("suspends policy, rewrites arguments/results and resolves next in a child without redispatch", async () => {
      const peer = createProtocolRig();
      const trace: string[] = [];
      const api = runtime.composition.createApi<
        Operations<
          {
            read(id: string): string;
          },
          Y
        >
      >("policy", {
        operations: {
          *read() {
            throw new Error("Missing driver");
          },
        },
      });
      const driver = (token: string) => ({
        *read(id: string) {
          const reply = yield* runtime.fromPromise((signal) => peer.send({ id, token }, signal));
          return reply.body;
        },
      });
      const execution = runtime.start(function* () {
        yield* api.install({
          operations: driver("parent"),
        });
        yield* api.around({
          operations: {
            read: (next) =>
              function* (id) {
                trace.push(id);
                if (id === "blocked") {
                  return "denied";
                }
                yield* runtime.fromPromise((signal) =>
                  peer.send({ id: "policy", token: "audit" }, signal),
                );
                return yield* runtime.composition.scoped(function* () {
                  yield* api.install({
                    operations: driver("child"),
                  });
                  const result = yield* next(`${id}:rewritten`);
                  return result.toUpperCase();
                });
              },
          },
        });
        const denied = yield* api.operations.read("blocked");
        const allowed = yield* api.operations.read("allowed");
        return { denied, allowed };
      });
      void execution.result.catch(() => undefined);
      await peer.waitForRequests(1);
      expect(peer.requests.map(({ id }) => id)).toEqual(["policy"]);
      peer.reply("policy", { status: 200, body: "approved" });
      await peer.waitForRequests(2);
      expect(peer.requests[1]).toEqual({ id: "allowed:rewritten", token: "child" });
      peer.reply("allowed:rewritten", { status: 200, body: "value" });
      expect(await execution.result).toEqual({ denied: "denied", allowed: "VALUE" });
      expect(trace).toEqual(["blocked", "allowed"]);
    });
    it("fails missing context, missing driver and duplicate installation before contacting the peer", async () => {
      const peer = createProtocolRig();
      const context = runtime.composition.createContext<string>("required");
      const api = runtime.composition.createApi<
        Operations<
          {
            read(): string;
          },
          Y
        >
      >("required", {
        operations: {
          *read() {
            throw new Error("Missing driver");
          },
        },
      });
      expect(await runtime.start(() => context.get()).result).toBeUndefined();
      await expect(runtime.start(() => context.expect()).result).rejects.toBeDefined();
      await expect(runtime.start(() => api.operations.read()).result).rejects.toThrow(
        "Missing driver",
      );
      await expect(
        runtime.start(function* () {
          const driver = {
            *read() {
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send({ id: "unexpected", token: "driver" }, signal),
              );
              return reply.body;
            },
          };
          yield* api.install({
            operations: driver,
          });
          yield* api.install({
            operations: driver,
          });
          return yield* api.operations.read();
        }).result,
      ).rejects.toThrow("Driver already installed");
      expect(peer.requests).toEqual([]);
    });
  });
});
