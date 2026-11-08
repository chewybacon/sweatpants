import {
  createHostedRecovery as createRecovery,
  createProtocolRig,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import { type CapabilityRequest } from "@sweatpan.ts/core";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Outcome, Work, Operation } from "@standard-durability/core";
import { type Attempts } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  createEffectCapabilities,
  installGuestRetention,
  type Hosting,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }

  for (const mode of [
    "fulfilled",
    "rejected",
    "throws",
    "bare",
    "bare-result",
    "nested",
  ] as const) {
    it(`${runtime.name}: rejects an erased ${mode} callback result before recording a result`, async () => {
      const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>(
        {
          program: "invalid-async-record",
          equals: isDeepStrictEqual,
        },
      );
      onTestFinished(() => store.close());
      let calls = 0;
      let settlements = 0;
      function assemble() {
        const effects = createEffectCapabilities(runtime, "invalid-record");
        const journal = store.open();
        let current: ReturnType<typeof acquireContext> | undefined;
        function acquireContext() {
          return effects.grant({}, { record: true });
        }
        const recovery = createRecovery(runtime, {
          name: "invalid-record-recovery",
          program: "invalid-async-record",
          matches: isDeepStrictEqual,
          *acquire() {
            const ctx = acquireContext();
            yield* ctx.install();
            current = ctx;
            return createScopedGuest(function* () {
              // Models a JS/untyped boundary where the callback result was erased.
              const work = (() => {
                calls++;
                if (mode === "throws") {
                  throw new Error("Delivery failed");
                }
                if (mode === "bare-result") {
                  return (function* () {
                    return 6;
                  })();
                }
                if (mode === "nested") {
                  return (function* () {
                    return yield* ctx.record(
                      function* () {
                        return { ok: true as const, value: 1 };
                      },
                      { key: "recorded-operation" },
                    );
                  })();
                }
                if (mode === "bare") {
                  return 6;
                }
                return mode === "rejected"
                  ? Promise.reject(new Error("Async callback failed"))
                  : Promise.resolve({ ok: true, value: 6 });
              }) as unknown as () => Operation<Outcome<unknown, unknown>, Y>;
              return yield* ctx.record(work, { key: "recorded-operation" });
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "invalid-record-host",
          journal,
          recovery: recovery.operations,
          attempts: {
            begin: (...args) => journal.attempts.begin(...args),
            *settle(...args: Parameters<typeof journal.attempts.settle>) {
              settlements++;
              return yield* journal.attempts.settle(...args);
            },
          },
          *handle(request) {
            if (!current) {
              throw new Error("Guest has not been acquired");
            }
            return yield* current.handle(request);
          },
        });
        return start(function* () {
          yield* host.around({
            *child([pending], next) {
              if (!current) {
                throw new Error("Guest has not been acquired");
              }
              return yield* current.admission.child([pending], next);
            },
          });
          yield* installGuestRetention(runtime.composition, host, recovery, journal);
          return yield* host.operations.run();
        });
      }
      await expect(assemble().result).rejects.toThrow(
        mode === "throws"
          ? "Delivery failed"
          : mode === "bare-result"
            ? "Effect work must return an Outcome"
            : mode === "nested"
              ? "Nested recorded work is not supported"
              : "Recorded work must return an Operation",
      );
      expect(settlements).toBe(0);
      const snapshot = await start(() => store.open().read()).result;
      expect(snapshot.frontier.position).toBe(0);
      store.reopen();
      expect((await assemble().result).state).toBe("occupied");
      expect(calls).toBe(1);
    });
  }

  it(`${runtime.name}: cancellation recovery abandons pending recording and replays recorded cleanup`, async () => {
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: "cancel-record-cleanup",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const peer = createProtocolRig();
    let bodyCalls = 0;
    let cleanupCalls = 0;
    function assemble(pause: boolean) {
      const journal = store.open();
      const effects = createEffectCapabilities(runtime, "cancel-record-cleanup");
      function fresh() {
        return effects.grant({}, { record: true });
      }
      const current = runtime.composition.createContext<ReturnType<typeof fresh>>("record-grant");
      const recovery = createRecovery(runtime, {
        name: "cancel-record-recovery",
        program: "cancel-record-cleanup",
        matches: isDeepStrictEqual,
        *acquire() {
          const grant = fresh();
          yield* grant.install();
          yield* current.set(grant);
          return createScopedGuest(function* (scope) {
            yield* scope.ensure(function* () {
              const released = yield* grant.record(
                function* () {
                  const value = yield* runtime.fromPromise(async (signal) => {
                    expect(signal.aborted).toBe(false);
                    cleanupCalls++;
                    return "released";
                  });
                  return { ok: true as const, value };
                },
                { key: "release" },
              );
              expect(released.value).toBe("released");
            });
            yield* grant.record(
              function* () {
                bodyCalls++;
                throw new Error("Delivery interrupted");
              },
              { key: "body" },
            );
            return "completed";
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "cancel-record-host",
        journal,
        recovery: recovery.operations,
        attempts: {
          begin: journal.attempts.begin,
          *settle(...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>) {
            const result = yield* journal.attempts.settle(...args);
            if (pause) {
              yield* runtime.fromPromise((signal) =>
                peer.send({ id: "accepted", token: "cleanup" }, signal),
              );
            }
            return result;
          },
        },
        *handle(request) {
          const grant = yield* current.expect();
          return yield* grant.handle(request);
        },
      });
      return start(function* () {
        yield* host.around({
          *child(args, next) {
            const grant = yield* current.expect();
            return yield* grant.admission.child(args, next);
          },
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        return yield* host.operations.run();
      });
    }
    await expect(assemble(false).result).rejects.toThrow("Delivery interrupted");
    store.reopen();
    await start(function* () {
      const journal = store.open();
      const snapshot = yield* journal.read();
      if (snapshot.status !== "running" || !snapshot.pending) {
        throw new Error("Expected pending record");
      }
      yield* journal.cancellation.request(snapshot.pending.id, "stop");
    }).result;
    const cleanup = assemble(true);
    await Promise.race([peer.waitForRequests(1), cleanup.result]);
    if (cleanupCalls === 0) {
      expect(await cleanup.result).toEqual({ state: "cancelled", reason: "stop" });
    }
    expect(cleanupCalls).toBe(1);
    await cleanup.cancel();
    store.reopen();
    await expect(assemble(false).result).resolves.toEqual({ state: "cancelled", reason: "stop" });
    expect({ bodyCalls, cleanupCalls }).toEqual({ bodyCalls: 1, cleanupCalls: 1 });
  });

  for (const finish of ["complete", "cancel", "revoke", "dispose"] as const) {
    it(`${runtime.name}: inline operation ${finish} uses scoped delivery and native cleanup`, async () => {
      const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>(
        {
          program: "async-record",
          equals: isDeepStrictEqual,
        },
      );
      onTestFinished(() => store.close());
      const peer = createProtocolRig();
      const context = runtime.composition.createContext<string>("inline-context");
      let calls = 0;
      let continued = 0;
      let released = 0;
      let grant: import("@sweatpan.ts/durable").AttemptGrant | undefined;
      let savedRecord:
        | ((
            work: () => Operation<Outcome<unknown, unknown>, Y>,
            options?: { readonly key?: string },
          ) => Operation<Outcome<unknown, unknown>, CapabilityRequest>)
        | undefined;
      function assemble() {
        const journal = store.open();
        const effects = createEffectCapabilities(runtime, "async-record");
        let current: ReturnType<typeof acquireContext> | undefined;
        function acquireContext() {
          return effects.grant({}, { record: true });
        }
        const recovery = createRecovery(runtime, {
          name: "async-record",
          program: "async-record",
          matches: isDeepStrictEqual,
          *acquire() {
            const ctx = acquireContext();
            yield* ctx.install();
            current = ctx;
            savedRecord = ctx.record;
            return createScopedGuest(function* () {
              const result = yield* ctx.record(
                function* () {
                  calls++;
                  expect(yield* context.expect()).toBe("delivery");
                  expect(yield* host.delivery.expect()).toEqual(grant);
                  yield* runtime.composition.ensure(function* () {
                    yield* runtime.fromPromise((signal) =>
                      peer.send({ id: "release", token: "close" }, signal),
                    );
                    released++;
                  });
                  const response = yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "work", token: "read" }, signal),
                  );
                  return { ok: true as const, value: response.body };
                },
                { key: "recorded-operation" },
              );
              expectTypeOf(result.value).toEqualTypeOf<string>();
              continued++;
              return result;
            });
          },
        });
        const host: Hosting<unknown, CapabilityRequest, unknown, unknown, Y> = createHosting(
          runtime.composition,
          {
            name: "async-host",
            recovery: recovery.operations,
            journal,
            attempts: {
              *begin(...args: Parameters<typeof journal.attempts.begin>) {
                const result = yield* journal.attempts.begin(...args);
                if (result.state === "granted") {
                  grant = result.grant;
                }
                return result;
              },
              settle: journal.attempts.settle,
            },
            *handle(request) {
              return yield* current!.handle(request);
            },
          },
        );
        return start(function* () {
          yield* context.set("delivery");
          yield* host.around({
            *child(args, next) {
              return yield* current!.admission.child(args, next);
            },
          });
          if (finish !== "dispose") {
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
          }
          return yield* host.operations.run();
        });
      }
      const first = assemble();
      if (finish === "dispose") {
        await expect(first.result).rejects.toThrow("Effect handler is not installed");
        expect(calls).toBe(0);
        // Holding the old grant does not keep its implementation live after disposal.
        await expect(
          start(() =>
            createScopedGuest(() =>
              savedRecord!(
                function* () {
                  return { ok: true as const, value: 1 };
                },
                { key: "after-disposal" },
              ),
            ).start(),
          ).result,
        ).rejects.toThrow("Record binding is not live");
        return;
      }
      await Promise.race([peer.waitForRequests(1), first.result]);
      expect(continued).toBe(0);
      let stopping: Promise<void> | undefined;
      if (finish === "cancel") {
        stopping = first.cancel();
      } else {
        if (finish === "revoke") {
          await start(() => store.open().attemptControl.invalidate(grant!, "external stop")).result;
        }
        peer.reply("work", { status: 200, body: "recorded text" });
      }
      await peer.waitForRequests(2);
      expect(continued).toBe(0);
      peer.reply("release", { status: 200, body: "closed" });
      if (stopping) {
        await stopping;
      }
      if (finish === "complete") {
        await expect(first.result).resolves.toEqual({
          state: "completed",
          value: { ok: true, value: "recorded text" },
        });
        store.reopen();
        await expect(assemble().result).resolves.toEqual({
          state: "completed",
          value: { ok: true, value: "recorded text" },
        });
      } else {
        await expect(first.result).rejects.toThrow();
        expect(continued).toBe(0);
        store.reopen();
        expect((await assemble().result).state).toBe(
          finish === "cancel" ? "occupied" : "invalidated",
        );
      }
      expect(calls).toBe(1);
      expect(released).toBe(1);
    });
  }
});
