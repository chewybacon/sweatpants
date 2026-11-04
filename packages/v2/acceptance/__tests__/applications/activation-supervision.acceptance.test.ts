import { createActivationIntents } from "@sweatpan.ts/durable";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Api, Operation, Outcome } from "@standard-durability/core";
import { createActivationReconciler, type ActivationReconciliation } from "@sweatpan.ts/deployment";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  createActivationDriver,
  createOwnedActivationDriver,
  type ActivationDriver,
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
  for (const interrupted of [false, true]) {
    it(`${runtime.name}: application ownership, reader disconnect, ${interrupted ? "shutdown" : "yield"}, and fresh-owner reconciliation`, async () => {
      type Report = ActivationReconciliation<string, string>;
      const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
        program: "supervised",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      const peer = createProtocolRig();
      const output = createBufferedSignal<string, void, Y>(runtime);
      const cleaning = createLatch<void>();
      const release = createLatch<void>();
      let cleanups = 0;
      function owner(limit: number) {
        const ready = createLatch<Api<ActivationDriver<Report, Y>, Y>>();
        const shutdownStarted = createLatch<void>();
        const lifetime = runtime.start(function* () {
          const driver = yield* createOwnedActivationDriver(runtime, {
            *run() {
              // Each native root assembles its own recovery, Host and scoped policy.
              let accepted = 0;
              const recovery = createHostedRecovery(runtime, {
                name: "supervised-recovery",
                program: "supervised",
                matches: isDeepStrictEqual,
                *acquire() {
                  return createScopedGuest(function* () {
                    const first: unknown = yield "first";
                    const second: unknown = yield "second";
                    return `${String(first)}:${String(second)}`;
                  });
                },
              });
              const host = createHosting(runtime.composition, {
                name: "supervised-host",
                journal,
                recovery: recovery.operations,
                attempts: journal.attempts,
                *handle(request: string): Operation<Outcome<string, string>, Y> {
                  yield* runtime.composition.ensure(function* () {
                    if (request === "first") {
                      cleaning.resolve();
                      yield* runtime.fromPromise(() => release.promise);
                    }
                    cleanups++;
                  });
                  output.send(request);
                  const reply = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: request, token: "provider" }, signal),
                  );
                  return { ok: true, value: reply.body };
                },
              });
              yield* host.attempts.around({
                operations: {
                  settle: (next) =>
                    function* (...args) {
                      const result = yield* next(...args);
                      accepted++;
                      return result;
                    },
                },
              });
              yield* host.around({
                operations: {
                  continuation: () =>
                    function* () {
                      return accepted >= limit
                        ? { action: "yield", reason: "budget" }
                        : { action: "continue" };
                    },
                },
              });
              const reconciler = createActivationReconciler(
                runtime.composition,
                "supervised-reconciler",
                {
                  intents: createActivationIntents(
                    runtime.composition,
                    "activation-intents",
                    store.activations,
                  ),
                  run: host.operations.run,
                },
              );
              return yield* reconciler.operations.reconcile();
            },
          });
          yield* runtime.composition.ensure(function* () {
            shutdownStarted.resolve();
          });
          ready.resolve(createActivationDriver(runtime.composition, "supervised-driver", driver));
          yield* runtime.fromPromise(() => new Promise<void>(() => {}));
        });
        void lifetime.result.catch(() => undefined);
        onTestFinished(async () => {
          release.resolve();
          await lifetime.cancel();
        });
        return { lifetime, ready: ready.promise, shutdownStarted: shutdownStarted.promise };
      }
      async function request(
        api: Api<ActivationDriver<Report, Y>, Y>,
      ): Promise<RuntimeExecution<Report>> {
        const requestScope = runtime.start(api.operations.start);
        onTestFinished(() => requestScope.cancel());
        return await requestScope.result; // Request has exited; application still owns work.
      }
      const admission = runtime.start(() => journal.admit("supervised", null));
      await admission.result;
      const firstOwner = owner(1);
      const first = await request(await firstOwner.ready);
      await Promise.race([peer.waitForRequests(1), first.result]);
      const reading = createLatch<void>();
      const reader = runtime.start(function* () {
        const subscription = yield* output.from(0);
        expect(yield* subscription.next()).toEqual({ done: false, value: "first" });
        reading.resolve();
        return yield* subscription.next();
      });
      void reader.result.catch(() => undefined);
      onTestFinished(() => reader.cancel());
      await reading.promise;
      await reader.cancel();
      expect(peer.aborted).toEqual([]);
      peer.reply("first", { status: 200, body: "one" });
      await cleaning.promise;
      let joined = false;
      const stopping = interrupted
        ? firstOwner.lifetime.cancel().then(() => {
            joined = true;
          })
        : undefined;
      if (interrupted) {
        await firstOwner.shutdownStarted;
      }
      expect(cleanups).toBe(0);
      expect(joined).toBe(false);
      release.resolve();
      if (interrupted) {
        await stopping;
        expect(joined).toBe(true);
        // Native interruption may race successful return from protected cleanup.
        // Either way the owner has joined it and no second delivery was started.
        const report = await first.result.catch(() => undefined);
        if (report) {
          expect(report).toEqual({
            state: "driven",
            result: { state: "yielded", reason: "budget" },
            acknowledged: false,
          });
        }
      } else {
        await expect(first.result).resolves.toEqual({
          state: "driven",
          result: { state: "yielded", reason: "budget" },
          acknowledged: false,
        });
        await firstOwner.lifetime.cancel();
      }
      expect(cleanups).toBe(1);
      journal = store.reopen();
      const secondOwner = owner(Infinity);
      const api = await secondOwner.ready;
      const second = await request(api);
      await Promise.race([peer.waitForRequests(2), second.result]);
      expect(peer.requests.map((entry) => entry.id)).toEqual(["first", "second"]);
      peer.reply("second", { status: 200, body: "two" });
      await expect(second.result).resolves.toEqual({
        state: "driven",
        result: { state: "completed", value: "one:two" },
        acknowledged: false,
      });
      const stable = await request(api);
      await expect(stable.result).resolves.toEqual({
        state: "driven",
        result: { state: "completed", value: "one:two" },
        acknowledged: true,
      });
      const idle = await request(api);
      await expect(idle.result).resolves.toEqual({ state: "idle" });
      await secondOwner.lifetime.cancel();
      expect(cleanups).toBe(2);
      expect(peer.requests).toHaveLength(2);
    });
  }
});
