import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Outcome } from "@standard-durability/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createActivationDriver,
  createOwnedActivationDriver,
  createHosting,
  type ActivationDriver,
  type HostedResult,
} from "@sweatpan.ts/hosting";
import { createBufferedSignal, type Runtime, type RuntimeExecution } from "@sweatpan.ts/runtime";
import {
  createHostedRecovery,
  createLatch,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const owner of ["request", "application"] as const) {
    it(`${runtime.name}: ${owner} ownership drives hosting independently of readers and survives only its owner`, async () => {
      const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
        program: "driver",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      const peer = createProtocolRig();
      const output = createBufferedSignal<string, void, Y>(runtime);
      const launched = createLatch<RuntimeExecution<HostedResult<string, string>>>();
      const leaveRequest = createLatch<void>();
      const requestLeft = createLatch<void>();
      const leaveApplication = createLatch<void>();
      let starts = 0;
      let deliveries = 0;
      let cleaned = 0;
      let escaped: ActivationDriver<HostedResult<string, string>, Y> | undefined;
      const work = {
        *run(): Operation<HostedResult<string, string>, Y> {
          const recovery = createHostedRecovery(runtime, {
            name: "driver-recovery",
            program: "driver",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* () {
                const answer: unknown = yield "work";
                return String(answer);
              });
            },
          });
          const host = createHosting(runtime.composition, {
            name: "driver-host",
            recovery: recovery.operations,
            journal,
            attempts: journal.attempts,
            *handle(): Operation<Outcome<string, string>, Y> {
              deliveries++;
              yield* runtime.composition.ensure(function* () {
                cleaned++;
              });
              output.send("started");
              const reply = yield* runtime.fromPromise((signal) =>
                peer.send({ id: "work", token: "driver" }, signal),
              );
              return { ok: true, value: reply.body };
            },
          });
          return yield* host.operations.run();
        },
      };
      const application = runtime.start(function* () {
        const background = yield* createOwnedActivationDriver(runtime, work);
        const api = createActivationDriver(runtime.composition, "activation", background);
        yield* api.around({
          operations: {
            start: (next) =>
              function* (...args) {
                starts++;
                return yield* next(...args);
              },
          },
        });
        yield* runtime.composition.scoped(function* () {
          if (owner === "request") {
            escaped = yield* createOwnedActivationDriver(runtime, work);
            yield* api.install({
              operations: escaped,
            });
          } else {
            escaped = background;
          }
          launched.resolve(yield* api.operations.start());
          yield* runtime.fromPromise(() => leaveRequest.promise);
        });
        requestLeft.resolve();
        yield* runtime.fromPromise(() => leaveApplication.promise);
      });
      void application.result.catch(() => undefined);
      onTestFinished(async () => {
        leaveRequest.resolve();
        leaveApplication.resolve();
        await application.cancel();
      });
      const task = await launched.promise;
      await Promise.race([peer.waitForRequests(1), task.result]);
      const reader = runtime.start(function* () {
        const subscription = yield* output.from(0);
        return yield* subscription.next();
      });
      onTestFinished(() => reader.cancel());
      await expect(reader.result).resolves.toEqual({ done: false, value: "started" });
      expect(peer.aborted).toEqual([]);
      leaveRequest.resolve();
      await requestLeft.promise;
      if (owner === "application") {
        expect(cleaned).toBe(0);
        expect(peer.aborted).toEqual([]);
        peer.reply("work", { status: 200, body: "done" });
        await expect(task.result).resolves.toEqual({ state: "completed", value: "done" });
      } else {
        await expect(task.result).rejects.toBeDefined();
        expect(peer.aborted).toEqual(["work"]);
      }
      expect(cleaned).toBe(1);
      expect(starts).toBe(1);
      leaveApplication.resolve();
      await application.result;
      const stale = runtime.start(() => escaped!.start());
      await expect(stale.result).rejects.toThrow("Activation owner has closed");
      journal = store.reopen();
      const resumed = runtime.start(work.run);
      onTestFinished(() => resumed.cancel());
      const result = await resumed.result;
      expect(result.state).toBe(owner === "application" ? "completed" : "occupied");
      expect(deliveries).toBe(1);
    });
  }
  it(`${runtime.name}: owner shutdown joins all active cleanup and rejects starts during shutdown`, async () => {
    const ready = createLatch<ActivationDriver<void, Y>>();
    const cleaning = createLatch<void>();
    const release = createLatch<void>();
    let cleanups = 0;
    const owner = runtime.start(function* () {
      const driver = yield* createOwnedActivationDriver(runtime, {
        *run() {
          yield* runtime.composition.ensure(function* () {
            cleanups++;
            if (cleanups === 2) {
              cleaning.resolve();
            }
            yield* runtime.fromPromise(() => release.promise);
          });
          yield* runtime.fromPromise(() => new Promise<void>(() => {}));
        },
      });
      yield* driver.start();
      yield* driver.start();
      ready.resolve(driver);
      yield* runtime.fromPromise(() => new Promise<void>(() => {}));
    });
    void owner.result.catch(() => undefined);
    onTestFinished(async () => {
      release.resolve();
      await owner.cancel();
    });
    const driver = await ready.promise;
    let joined = false;
    const stopping = owner.cancel().then(() => {
      joined = true;
    });
    await cleaning.promise;
    expect(joined).toBe(false);
    const late = runtime.start(() => driver.start());
    await expect(late.result).rejects.toThrow("Activation owner has closed");
    release.resolve();
    await stopping;
    expect(joined).toBe(true);
  });
});
