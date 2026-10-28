import { readJournal } from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import type { Work } from "@standard-durability/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createRecovery } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { describe, expect, it } from "vitest";
import { createLatch, createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  // Run each resource protocol inside a granted handler, so shutdown evidence also
  // proves that native failures never become authored journal outcomes.
  function startHost(work: Work<unknown, Y>) {
    const journal = createMemoryJournal<string, string, string, string>({
      program: "resource-session",
      equals: isDeepStrictEqual,
    });
    const recovery = createRecovery(runtime.composition, {
      name: "resource-recovery",
      program: "resource-session",
      matches: isDeepStrictEqual,
      *acquire() {
        return createScopedGuest(function* () {
          yield "session";
          return "completed";
        });
      },
    });
    const host = createHosting(runtime.composition, {
      name: "resource-host",
      journal,
      attempts: journal.attempts,
      recovery: recovery.operations,
      *handle() {
        yield* work();
        return { ok: true, value: "released" } as const;
      },
    });
    const execution = runtime.start(() => host.operations.run());
    return {
      ...execution,
      async assertRecoverable() {
        const state = await runtime.start(() => readJournal(journal)).result;
        expect(state.status).toBe("running");
        expect(state.history).toEqual([]);
        expect((await runtime.start(() => host.operations.run()).result).state).toBe("occupied");
      },
    };
  }
  describe(`${runtime.name}: hosted resource acquisition and shutdown protocol`, () => {
    it("aborts pending acquisition without using or releasing an unacquired resource", async () => {
      const peer = createProtocolRig();
      let used = false;
      let released = false;
      const execution = startHost(function* () {
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
        await execution.assertRecoverable();
      } finally {
        // Also allows an old masked-acquisition implementation to be cleaned up on failure.
        if (!peer.aborted.includes("connect")) {
          peer.reply("connect", { status: 200, body: "connection" });
        }
        await execution.cancel();
      }
    });

    it("leaves failed resource acquisition occupied without releasing an unacquired resource", async () => {
      const peer = createProtocolRig();
      let releases = 0;
      const execution = startHost(function* () {
        return yield* runtime.using(
          () =>
            runtime.fromPromise((signal) => peer.send({ id: "connect", token: "session" }, signal)),
          function* () {
            throw new Error("Must not use a failed acquisition");
          },
          function* () {
            releases++;
          },
        );
      });
      void execution.result.catch(() => undefined);
      try {
        await Promise.race([peer.waitForRequests(1), execution.result]);
        peer.fail("connect", new Error("Cannot acquire session"));
        await expect(execution.result).rejects.toBeDefined();
        expect(releases).toBe(0);
        await execution.assertRecoverable();
      } finally {
        await execution.cancel();
      }
    });

    it("registers release before entering use and waits for its close reply on cancellation", async () => {
      const peer = createProtocolRig();
      const ready = createLatch<void>();
      let released = 0;
      const execution = startHost(function* () {
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
      await execution.assertRecoverable();
    });

    it("joins asynchronous sibling cleanup after transport loss without accepting a domain failure", async () => {
      const peer = createProtocolRig();
      const cleanup = createProtocolRig();
      const released: string[] = [];
      const execution = startHost(function* () {
        return yield* runtime.all(
          ["broken", "sibling"].map(
            (id) =>
              function* () {
                return yield* runtime.using(
                  function* () {
                    return id;
                  },
                  () =>
                    runtime.fromPromise((signal) => peer.send({ id, token: "session" }, signal)),
                  function* () {
                    released.push(id);
                    if (id === "sibling") {
                      yield* runtime.fromPromise((signal) =>
                        cleanup.send({ id: "close", token: id }, signal),
                      );
                    }
                  },
                );
              },
          ),
        );
      });
      let settled = false;
      void execution.result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.race([peer.waitForRequests(2), execution.result]);
      peer.fail("broken", new Error("Connection lost"));
      await Promise.race([cleanup.waitForRequests(1), execution.result]);
      try {
        expect(peer.aborted).toEqual(["sibling"]);
        expect(settled).toBe(false);
        expect(cleanup.requests[0]).toEqual({ id: "close", token: "sibling" });
      } finally {
        cleanup.reply("close", { status: 200, body: "closed" });
        await execution.cancel();
      }
      await expect(execution.result).rejects.toBeDefined();
      expect(released.sort()).toEqual(["broken", "sibling"]);
      await execution.assertRecoverable();
    });

    it("drains cleanup after a close failure; cancel resolves while result reports failure", async () => {
      const peer = createProtocolRig();
      const context = runtime.composition.createContext<string>("cleanup-token");
      const execution = startHost(function* () {
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
      await execution.assertRecoverable();
    });
  });
});
