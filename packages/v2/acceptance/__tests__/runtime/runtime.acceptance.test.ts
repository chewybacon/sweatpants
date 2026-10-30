import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import { createProtocolRig } from "@sweatpan.ts/testing";
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
  });
});
