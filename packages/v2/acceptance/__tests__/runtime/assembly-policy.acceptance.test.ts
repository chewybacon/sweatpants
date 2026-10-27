import { describe, expect, it } from "vitest";
import type { Middleware, Operations } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  type Reads = { read(id: string): string };
  describe(`${runtime.name}: behavior belongs to the assembled stack`, () => {
    for (const cacheFirst of [false, true]) {
      it(`deliberately controls cache interception through assembly order (cache first: ${cacheFirst})`, async () => {
        const peer = createProtocolRig();
        const trace: string[] = [];
        const api = runtime.composition.createApi<Reads>("assembled-cache", {
          *read(id) {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: `read:${id}`, token: "store" }, signal),
            );
            return reply.body;
          },
        });
        const authorize: Middleware<Reads, Y> = {
          *read([id], next) {
            trace.push(`authorize:${id}`);
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: `authorize:${id}`, token: "policy" }, signal),
            );
            if (reply.status !== 200) {
              return "denied";
            }
            return yield* next(id);
          },
        };
        const cache: Middleware<Reads, Y> = {
          *read([id], next) {
            trace.push(`cache:${id}`);
            if (id === "cached") {
              return "cached value";
            }
            return yield* next(id);
          },
        };
        const execution = runtime.start(function* () {
          for (const layer of cacheFirst ? [cache, authorize] : [authorize, cache]) {
            yield* api.around(layer);
          }
          const cached = yield* api.operations.read("cached");
          const live = yield* api.operations.read("live");
          return { cached, live };
        });
        void execution.result.catch(() => undefined);
        try {
          if (!cacheFirst) {
            await peer.waitForRequests(1);
            peer.reply("authorize:cached", { status: 403, body: "not allowed" });
          }
          await peer.waitForRequests(cacheFirst ? 1 : 2);
          peer.reply("authorize:live", { status: 200, body: "allowed" });
          await peer.waitForRequests(cacheFirst ? 2 : 3);
          peer.reply("read:live", { status: 200, body: "live value" });
          expect(await execution.result).toEqual({
            cached: cacheFirst ? "cached value" : "denied",
            live: "live value",
          });
          expect(trace).toEqual(
            cacheFirst
              ? ["cache:cached", "cache:live", "authorize:live"]
              : ["authorize:cached", "authorize:live", "cache:live"],
          );
          expect(peer.requests.map(({ id }) => id)).toEqual(
            cacheFirst
              ? ["authorize:live", "read:live"]
              : ["authorize:cached", "authorize:live", "read:live"],
          );
        } finally {
          await execution.cancel();
        }
      });
    }

    it("replaces a context capability with a wrapped raw implementation and restores the facade", async () => {
      const peer = createProtocolRig();
      const trace: string[] = [];
      const capability = runtime.composition.createContext<Operations<Reads, Y>>("reader");
      const driver = (token: string): Operations<Reads, Y> => ({
        *read(id) {
          const reply = yield* runtime.fromPromise((signal) => peer.send({ id, token }, signal));
          return reply.body;
        },
      });
      const raw = driver("raw");
      const api = runtime.composition.createApi<Reads>("replaceable-reader", raw);
      // Capturing the facade does not bind it to the scope where it was obtained.
      const captured = api.operations;
      const execution = runtime.start(function* () {
        yield* capability.set(captured);
        yield* api.around({
          *read(args, next) {
            trace.push(`intercept:${args[0]}`);
            return yield* next(...args);
          },
        });
        const parentClient = yield* capability.expect();
        const parent = yield* parentClient.read("parent");
        const child = yield* runtime.composition.scoped(function* () {
          yield* api.install(driver("child"));
          yield* capability.set({
            *read(id) {
              trace.push(`replacement:${id}`);
              // Deliberately call the implementation, bypassing this API's chain.
              const value = yield* raw.read(id);
              return `wrapped:${value}`;
            },
          });
          const childClient = yield* capability.expect();
          const replacement = yield* childClient.read("replacement");
          const facade = yield* captured.read("captured");
          return { replacement, facade };
        });
        const restoredClient = yield* capability.expect();
        const restored = yield* restoredClient.read("restored");
        return { parent, child, restored };
      });
      void execution.result.catch(() => undefined);
      try {
        for (const [index, id] of ["parent", "replacement", "captured", "restored"].entries()) {
          await peer.waitForRequests(index + 1);
          peer.reply(id, { status: 200, body: id });
        }
        expect(await execution.result).toEqual({
          parent: "parent",
          child: { replacement: "wrapped:replacement", facade: "captured" },
          restored: "restored",
        });
        expect(peer.requests).toEqual([
          { id: "parent", token: "raw" },
          { id: "replacement", token: "raw" },
          { id: "captured", token: "child" },
          { id: "restored", token: "raw" },
        ]);
        expect(trace).toEqual([
          "intercept:parent",
          "replacement:replacement",
          "intercept:captured",
          "intercept:restored",
        ]);
      } finally {
        await execution.cancel();
      }
      // A fresh root has no capability binding from the disposed execution.
      expect(await runtime.start(() => capability.get()).result).toBeUndefined();
    });

    it("keeps nested capabilities and finalizer calls inside their assembled scope", async () => {
      const peer = createProtocolRig();
      const trace: string[] = [];
      const token = runtime.composition.createContext<string>("nested-token");
      const transport = runtime.composition.createApi<Reads>("nested-transport", {
        *read(id) {
          const credential = yield* token.expect();
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id, token: credential }, signal),
          );
          return reply.body;
        },
      });
      const dependency = runtime.composition.createContext<Operations<Reads, Y>>("nested-client");
      const service = runtime.composition.createApi<Reads>("nested-service", {
        *read(id) {
          const client = yield* dependency.expect();
          return yield* client.read(id);
        },
      });
      const execution = runtime.start(function* () {
        yield* token.set("parent");
        yield* dependency.set(transport.operations);
        yield* transport.around({
          *read(args, next) {
            trace.push(`transport:${args[0]}`);
            return yield* next(...args);
          },
        });
        yield* service.around({
          *read(args, next) {
            trace.push(`service:${args[0]}`);
            return yield* next(...args);
          },
        });
        yield* runtime.composition.scoped(function* () {
          yield* token.set("child");
          yield* runtime.composition.ensure(function* () {
            yield* service.operations.read("close");
          });
          yield* service.operations.read("work");
        });
        return yield* service.operations.read("parent");
      });
      void execution.result.catch(() => undefined);
      // Drive cleanup to completion before awaiting the enclosing execution.
      for (const [index, id] of ["work", "close", "parent"].entries()) {
        await peer.waitForRequests(index + 1);
        peer.reply(id, { status: 200, body: id });
      }
      try {
        expect(await execution.result).toBe("parent");
        expect(peer.requests).toEqual([
          { id: "work", token: "child" },
          { id: "close", token: "child" },
          { id: "parent", token: "parent" },
        ]);
        expect(trace).toEqual([
          "service:work",
          "transport:work",
          "service:close",
          "transport:close",
          "service:parent",
          "transport:parent",
        ]);
      } finally {
        await execution.cancel();
      }
    });
  });
});
