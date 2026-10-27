import { describe, expect, it } from "vitest";
import { createLatch, createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "./assembly.ts";

forEachRuntime((runtime) => {
  describe(`${runtime.name}: resource acquisition and shutdown protocol`, () => {
    it("aborts pending acquisition without using or releasing an unacquired resource", async () => {
      const peer = createProtocolRig();
      let used = false;
      let released = false;
      const execution = runtime.start(function* () {
        return yield* runtime.using(
          () =>
            runtime.fromPromise((signal) => peer.send({ id: "connect", token: "session" }, signal)),
          function* () {
            used = true;
          },
          function* () {
            released = true;
          },
        );
      });
      // Deliberately don't attach a result observer before cancel: cancel owns that observation.
      await peer.waitForRequests(1);
      try {
        await execution.cancel();
        await expect(execution.result).rejects.toBeDefined();
        expect(peer.aborted).toEqual(["connect"]);
        expect(used).toBe(false);
        expect(released).toBe(false);
      } finally {
        // Also allows an old masked-acquisition implementation to be cleaned up on failure.
        if (!peer.aborted.includes("connect")) {
          peer.reply("connect", { status: 200, body: "connection" });
        }
        await execution.cancel();
      }
    });

    it("registers release before entering use and waits for its close reply on cancellation", async () => {
      const peer = createProtocolRig();
      const ready = createLatch<void>();
      let released = 0;
      const execution = runtime.start(function* () {
        return yield* runtime.using(
          () =>
            runtime.fromPromise((signal) => peer.send({ id: "connect", token: "session" }, signal)),
          function* () {
            ready.resolve();
            return yield* runtime.fromPromise((signal) =>
              peer.send({ id: "use", token: "session" }, signal),
            );
          },
          function* () {
            released++;
            yield* runtime.fromPromise((signal) =>
              peer.send({ id: "close", token: "session" }, signal),
            );
          },
        );
      });
      await peer.waitForRequests(1);
      peer.reply("connect", { status: 200, body: "connection" });
      await ready.promise;
      await peer.waitForRequests(2);
      const stopped = execution.cancel();
      let settled = false;
      void stopped.then(() => {
        settled = true;
      });
      await peer.waitForRequests(3);
      try {
        expect(peer.aborted).toEqual(["use"]);
        expect(settled).toBe(false);
      } finally {
        peer.reply("close", { status: 200, body: "closed" });
        await stopped;
      }
      await expect(execution.result).rejects.toBeDefined();
      expect(released).toBe(1);
      await execution.cancel();
      expect(released).toBe(1);
    });

    it("drains cleanup after a close failure; cancel resolves while result reports failure", async () => {
      const peer = createProtocolRig();
      const context = runtime.composition.createContext<string>("cleanup-token");
      const execution = runtime.start(function* () {
        yield* context.set("owned");
        yield* runtime.composition.ensure(function* () {
          const token = yield* context.expect();
          yield* runtime.fromPromise((signal) => peer.send({ id: "close-last", token }, signal));
        });
        yield* runtime.composition.ensure(function* () {
          const token = yield* context.expect();
          yield* runtime.fromPromise((signal) => peer.send({ id: "close-first", token }, signal));
        });
        yield* runtime.fromPromise((signal) =>
          peer.send({ id: "pending", token: "owned" }, signal),
        );
      });
      await peer.waitForRequests(1);
      const first = execution.cancel();
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      await peer.waitForRequests(2);
      expect(peer.requests[1]).toEqual({ id: "close-first", token: "owned" });
      peer.fail("close-first", new Error("Close failed"));
      await peer.waitForRequests(3);
      const second = execution.cancel();
      try {
        expect(peer.requests[2]).toEqual({ id: "close-last", token: "owned" });
        expect(settled).toBe(false);
      } finally {
        peer.reply("close-last", { status: 200, body: "closed" });
        await Promise.all([first, second]);
      }
      // Let the event loop observe any accidentally unhandled result rejection.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(execution.result).rejects.toBeDefined();
      expect(peer.requests.map(({ id }) => id)).toEqual(["pending", "close-first", "close-last"]);
    });
  });
});
