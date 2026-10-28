import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Outcome } from "@standard-durability/core";
import { createRecovery } from "@sweatpan.ts/durable";
import { createIteratorGuest } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createProtocolRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime((runtime) => {
  it(`${runtime.name}: sibling hosts inherit middleware, isolate Guest drivers and dispose exact incarnations`, async () => {
    const owner = runtime.composition.createContext<string>("execution-owner");
    const peer = createProtocolRig();
    const closed: string[] = [];
    const calls: string[] = [];
    let facadeCloses = 0;
    function acquire(label: string) {
      const guest = createIteratorGuest(function* () {
        const value: unknown = yield "read";
        if (typeof value !== "string") {
          throw new Error("Expected reply text");
        }
        return { owner: label, value };
      });
      return {
        ...guest,
        *close() {
          closed.push(label);
          yield* guest.close();
        },
      };
    }
    const recovery = createRecovery(runtime.composition, {
      name: "shared-recovery",
      program: "read",
      matches: isDeepStrictEqual,
      *acquire() {
        return acquire(yield* owner.expect());
      },
    });
    const captured = recovery.execution.operations;
    const execution = runtime.start(function* () {
      yield* owner.set("parent");
      yield* recovery.execution.around({
        *start(args, next) {
          calls.push(`start:${yield* owner.expect()}`);
          return yield* next(...args);
        },
        *resume([outcome], next) {
          expectTypeOf(outcome).toEqualTypeOf<Outcome<unknown, unknown>>();
          calls.push(`resume:${yield* owner.expect()}`);
          return yield* next(outcome);
        },
        *close(args, next) {
          facadeCloses++;
          return yield* next(...args);
        },
      });
      const results = yield* runtime.all(
        ["a", "b"].map(
          (label) =>
            function* () {
              yield* owner.set(label);
              if (label === "a") {
                yield* recovery.execution.around({
                  resume(args, next) {
                    // next resolves the driver where it executes, without redispatching
                    // this middleware. The enclosing incarnation still owns its disposal.
                    return runtime.composition.scoped(function* () {
                      yield* recovery.execution.install(acquire("override"));
                      yield* captured.start();
                      return yield* next(...args);
                    });
                  },
                });
              }
              const journal = createMemoryJournal<
                { owner: string; value: string },
                string,
                string,
                string
              >({
                program: "read",
                equals: isDeepStrictEqual,
              });
              const host = createHosting(runtime.composition, {
                name: `host-${label}`,
                recovery: recovery.operations,
                journal,
                attempts: journal.attempts,
                *handle() {
                  const reply = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: label, token: label }, signal),
                  );
                  return { ok: true, value: reply.body } as const;
                },
              });
              return yield* host.operations.run();
            },
        ),
      );
      expect(yield* owner.expect()).toBe("parent");
      return results;
    });
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    await Promise.race([peer.waitForRequests(2), execution.result]);
    peer.reply("b", { status: 200, body: "B" });
    peer.reply("a", { status: 200, body: "A" });
    const results = await execution.result;
    expectTypeOf(results).toEqualTypeOf<
      readonly HostedResult<{ owner: string; value: string }, string>[]
    >();
    expect(results).toEqual([
      { state: "completed", value: { owner: "override", value: "A" } },
      { state: "completed", value: { owner: "b", value: "B" } },
    ]);
    expect(calls.filter((value) => value.startsWith("resume:")).sort()).toEqual([
      "resume:a",
      "resume:b",
    ]);
    expect(closed.sort()).toEqual(["a", "a", "b", "b", "override"]);
    expect(facadeCloses).toBe(0);
    // A facade carried into another execution does not retain a disposed driver.
    await expect(runtime.start(() => captured.start()).result).rejects.toThrow(
      "Execution driver is not installed",
    );
  });
});
