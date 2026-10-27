import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { createLatch, createProtocolRig } from "@sweatpan.ts/testing";
import type { RuntimeExecution } from "@sweatpan.ts/runtime";
import { createApplication } from "./application.ts";
import type { ReadOutcome } from "./application.ts";
import { forEachRuntime } from "./assembly.ts";

function own<T>(execution: RuntimeExecution<T>) {
  // Observe native failures immediately, even when the scenario first awaits a barrier.
  void execution.result.catch(() => undefined);
  onTestFinished(() => execution.cancel());
  return execution;
}

forEachRuntime((runtime, createClient) => {
  describe(`${runtime.name}: portable application over a simulated protocol`, () => {
    it("runs typed concurrent calls, preserves input order and awaits resource release", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      const events: string[] = [];
      const execution = own(
        runtime.start(function* () {
          yield* app.install(createClient(rig));
          return yield* runtime.using(
            function* () {
              events.push("acquire");
              return "session";
            },
            function* () {
              yield* runtime.sleep(0);
              return yield* app.readPair();
            },
            function* (session) {
              yield* runtime.fromPromise(async () => {
                events.push(`release:${session}`);
              });
            },
          );
        }),
      );
      await rig.waitForRequests(2);
      expect(rig.requests.map((request) => request.token)).toEqual(["root", "root"]);
      rig.reply("second", { status: 200, body: "two" });
      rig.reply("first", { status: 200, body: "one" });
      const result = await execution.result;
      expectTypeOf(result).toEqualTypeOf<readonly ReadOutcome[]>();
      expect(result).toEqual([
        { ok: true, value: { body: "one" } },
        { ok: true, value: { body: "two" } },
      ]);
      expect(events).toEqual(["acquire", "release:session"]);
      await execution.cancel();
      await execution.cancel();
      expect(events).toHaveLength(2);
    });

    it("resolves captured facades in child scopes and restores parent bindings", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      const captured = app.repository.operations;
      const events: string[] = [];
      const execution = own(
        runtime.start(function* () {
          yield* app.install(createClient(rig));
          yield* app.repository.around({
            *read(args, next) {
              events.push(`before:${args[0]}`);
              return yield* next(...args);
            },
          });
          yield* runtime.composition.scoped(function* () {
            yield* app.token.set("child");
            yield* runtime.composition.ensure(function* () {
              events.push("child-cleanup");
            });
            return yield* captured.read("child");
          });
          return yield* captured.read("parent");
        }),
      );
      await rig.waitForRequests(1);
      expect(rig.requests[0]?.token).toBe("child");
      rig.reply("child", { status: 200, body: "child result" });
      await rig.waitForRequests(2);
      expect(rig.requests[1]?.token).toBe("root");
      expect(events).toEqual(["before:child", "child-cleanup", "before:parent"]);
      rig.reply("parent", { status: 200, body: "parent result" });
      expect(await execution.result).toEqual({ ok: true, value: { body: "parent result" } });
    });

    it("keeps concurrent child context overrides isolated", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      const execution = own(
        runtime.start(function* () {
          yield* app.install(createClient(rig));
          yield* runtime.all(
            ["a", "b"].map(
              (id) =>
                function* () {
                  yield* app.token.set(id);
                  return yield* app.repository.operations.read(id);
                },
            ),
          );
          return yield* app.repository.operations.read("parent");
        }),
      );
      await rig.waitForRequests(2);
      expect(
        rig.requests.map(({ id, token }) => [id, token]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
      ).toEqual([
        ["a", "a"],
        ["b", "b"],
      ]);
      rig.reply("a", { status: 200, body: "a" });
      rig.reply("b", { status: 200, body: "b" });
      await rig.waitForRequests(3);
      expect(rig.requests[2]?.token).toBe("root");
      rig.reply("parent", { status: 200, body: "parent" });
      await execution.result;
    });

    it("keeps expected failures as data and creates fresh work on every start", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      let starts = 0;
      function* work() {
        starts++;
        yield* app.install(createClient(rig));
        return yield* app.repository.operations.read("request");
      }
      const first = own(runtime.start(work));
      await rig.waitForRequests(1);
      rig.reply("request", { status: 403, body: "denied" });
      const outcome = await first.result;
      if (outcome.ok) {
        throw new Error("Expected domain failure");
      }
      expectTypeOf(outcome.error.status).toEqualTypeOf<number>();
      expect(outcome.error.status).toBe(403);
      const second = own(runtime.start(work));
      await rig.waitForRequests(2);
      rig.reply("request", { status: 200, body: "allowed" });
      expect(await second.result).toEqual({ ok: true, value: { body: "allowed" } });
      expect(starts).toBe(2);
    });

    it("aborts protocol IO and makes cancellation wait for asynchronous cleanup", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      const releasing = createLatch<void>();
      const allowRelease = createLatch<void>();
      let releases = 0;
      let settled = false;
      onTestFinished(() => allowRelease.resolve());
      const execution = own(
        runtime.start(function* () {
          yield* app.install(createClient(rig));
          return yield* runtime.using(
            function* () {
              return "session";
            },
            () => app.repository.operations.read("pending"),
            function* () {
              releases++;
              releasing.resolve();
              yield* runtime.fromPromise(() => allowRelease.promise);
            },
          );
        }),
      );
      void execution.result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await rig.waitForRequests(1);
      const cancelled = execution.cancel();
      const again = execution.cancel();
      await releasing.promise;
      expect(rig.aborted).toEqual(["pending"]);
      expect(settled).toBe(false);
      allowRelease.resolve();
      await Promise.all([cancelled, again]);
      await expect(execution.result).rejects.toBeDefined();
      expect(releases).toBe(1);
    });

    it("propagates transport loss, cancels sibling IO and joins its cleanup", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      const released: string[] = [];
      const execution = own(
        runtime.start(function* () {
          yield* app.install(createClient(rig));
          return yield* runtime.all(
            ["broken", "sibling"].map(
              (id) =>
                function* () {
                  return yield* runtime.using(
                    function* () {
                      return id;
                    },
                    () => app.repository.operations.read(id),
                    function* () {
                      released.push(id);
                    },
                  );
                },
            ),
          );
        }),
      );
      await rig.waitForRequests(2);
      rig.fail("broken", new Error("Connection lost"));
      await expect(execution.result).rejects.toBeDefined();
      expect(rig.aborted).toEqual(["sibling"]);
      expect(released.sort()).toEqual(["broken", "sibling"]);
    });

    it("does not release a resource whose protocol acquisition failed", async () => {
      const rig = createProtocolRig();
      const app = createApplication(runtime);
      let releases = 0;
      const execution = own(
        runtime.start(function* () {
          yield* app.install(createClient(rig));
          return yield* runtime.using(
            () => app.repository.operations.read("acquire"),
            function* () {
              throw new Error("Must not use a failed acquisition");
            },
            function* () {
              releases++;
            },
          );
        }),
      );
      await rig.waitForRequests(1);
      rig.fail("acquire", new Error("Cannot acquire session"));
      await expect(execution.result).rejects.toBeDefined();
      expect(releases).toBe(0);
    });
  });
});
