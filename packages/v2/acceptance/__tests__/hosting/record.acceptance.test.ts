import { type CapabilityRequest } from "@sweatpan.ts/core";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Outcome, Work, Operation } from "@standard-durability/core";
import { createRecovery, type Attempts } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  createEffectCapabilities,
  installGuestRetention,
  type Hosting,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createProtocolRig, createSqliteJournalRig } from "@sweatpan.ts/testing";
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
        const recovery = createRecovery(runtime.composition, {
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
                    return yield* ctx.record({ key: "recorded-operation" }, function* () {
                      return { ok: true as const, value: 1 };
                    });
                  })();
                }
                if (mode === "bare") {
                  return 6;
                }
                return mode === "rejected"
                  ? Promise.reject(new Error("Async callback failed"))
                  : Promise.resolve({ ok: true, value: 6 });
              }) as unknown as () => Operation<Outcome<unknown, unknown>, Y>;
              return yield* ctx.record({ key: "recorded-operation" }, work);
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
            options: { readonly key: string },
            work: () => Operation<Outcome<unknown, unknown>, Y>,
          ) => Operation<Outcome<unknown, unknown>, CapabilityRequest>)
        | undefined;
      function assemble() {
        const journal = store.open();
        const effects = createEffectCapabilities(runtime, "async-record");
        let current: ReturnType<typeof acquireContext> | undefined;
        function acquireContext() {
          return effects.grant({}, { record: true });
        }
        const recovery = createRecovery(runtime.composition, {
          name: "async-record",
          program: "async-record",
          matches: isDeepStrictEqual,
          *acquire() {
            const ctx = acquireContext();
            yield* ctx.install();
            current = ctx;
            savedRecord = ctx.record;
            return createScopedGuest(function* () {
              const result = yield* ctx.record({ key: "recorded-operation" }, function* () {
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
              });
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
              savedRecord!({ key: "after-disposal" }, function* () {
                return { ok: true as const, value: 1 };
              }),
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

  it(`${runtime.name}: repeated keys retain distinct ordered outcomes across replay`, async () => {
    const store = createSqliteJournalRig<number[], CapabilityRequest, unknown, string, unknown, Y>({
      program: "record-loop",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const peer = createProtocolRig();
    let calls = 0;
    const delivered: unknown[] = [];
    function assemble(pause: boolean, key = "roll-dice") {
      const journal = store.open();
      const effects = createEffectCapabilities(runtime, "record-loop");
      let ctx: ReturnType<typeof acquireContext> | undefined;
      function acquireContext() {
        return effects.grant({}, { record: true });
      }
      const recovery = createRecovery(runtime.composition, {
        name: "record-loop",
        program: "record-loop",
        matches: isDeepStrictEqual,
        *acquire() {
          const current = acquireContext();
          ctx = current;
          yield* current.install();
          return createScopedGuest(function* () {
            const results: number[] = [];
            for (let i = 0; i < 3; i++) {
              const outcome = yield* current.record({ key }, function* () {
                return { ok: true as const, value: ++calls };
              });
              results.push(outcome.value);
            }
            return results;
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "record-loop-host",
        journal,
        recovery: recovery.operations,
        attempts: {
          begin: journal.attempts.begin,
          *settle(...args: Parameters<typeof journal.attempts.settle>) {
            const result = yield* journal.attempts.settle(...args);
            if (pause) {
              yield* runtime.fromPromise((signal) =>
                peer.send({ id: "accepted", token: "pause" }, signal),
              );
            }
            return result;
          },
        },
        *handle(request) {
          delivered.push(request.input);
          return yield* ctx!.handle(request);
        },
      });
      return start(function* () {
        yield* host.around({
          *child(args, next) {
            return yield* ctx!.admission.child(args, next);
          },
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        return yield* host.operations.run();
      });
    }
    await expect(assemble(false, "  ").result).rejects.toThrow("Record key must be non-empty");
    expect(calls).toBe(0);
    expect(delivered).toEqual([]);
    const first = assemble(true);
    await Promise.race([peer.waitForRequests(1), first.result]);
    await first.cancel();
    store.reopen();
    await expect(assemble(false).result).resolves.toEqual({ state: "completed", value: [1, 2, 3] });
    expect(calls).toBe(3);
    expect(delivered).toEqual([0, 1, 2].map((sequence) => ({ key: "roll-dice", sequence })));
  });

  // Both interruptions happen after the callback ran. Only one has an accepted value.
  for (const failed of [false, true]) {
    for (const accepted of [true, false]) {
      it(`${runtime.name}: recorded ${failed ? "failure" : "success"} ${accepted ? "replays accepted values" : "keeps an unaccepted attempt occupied"} after reopen`, async () => {
        const store = createSqliteJournalRig<
          { roll: Outcome<number, { code: string }>; card: { suit: string; rank: number } },
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          program: "recorded-draw",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        const peer = createProtocolRig();
        const events: string[] = [];
        let rollCalls = 0;
        let cardCalls = 0;

        function assemble(pause: boolean, recordKey = "roll-dice") {
          const effects = createEffectCapabilities(runtime, "recording");
          const journal = store.open();
          let granted = false;
          let current: ReturnType<typeof acquireGrant> | undefined;
          function acquireGrant() {
            return effects.grant({}, { record: true });
          }
          function* rollDice() {
            // A deterministic changing source proves whether the callback was repeated.
            expect(granted).toBe(true);
            events.push("roll");
            rollCalls++;
            return failed
              ? { ok: false as const, error: { code: "empty-deck" } }
              : { ok: true as const, value: rollCalls };
          }
          const recovery = createRecovery(runtime.composition, {
            name: "record-recovery",
            program: "recorded-draw",
            matches: isDeepStrictEqual,
            *acquire() {
              const grant = acquireGrant();
              yield* grant.install();
              current = grant;
              return createScopedGuest(function* () {
                const roll = yield* grant.record({ key: recordKey }, rollDice);
                if (roll.ok) {
                  expectTypeOf(roll.value).toEqualTypeOf<number>();
                } else {
                  expectTypeOf(roll.error).toEqualTypeOf<{ code: string }>();
                }
                const card = yield* grant.record({ key: "pick-card" }, function* () {
                  expect(granted).toBe(true);
                  cardCalls++;
                  return { ok: true as const, value: { suit: "hearts", rank: 7 } };
                });
                expectTypeOf(card.value).toEqualTypeOf<{ suit: string; rank: number }>();
                return { roll, card: card.value };
              });
            },
          });
          const host = createHosting(runtime.composition, {
            name: "record-host",
            journal,
            recovery: recovery.operations,
            attempts: {
              *begin(
                ...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["begin"]>
              ) {
                const result = yield* journal.attempts.begin(...args);
                granted = result.state === "granted";
                if (granted) {
                  events.push("granted");
                }
                return result;
              },
              *settle(
                ...args: Parameters<Attempts<CapabilityRequest, unknown, string, Y>["settle"]>
              ) {
                if (pause && !accepted) {
                  yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "pause", token: "before-acceptance" }, signal),
                  );
                }
                const result = yield* journal.attempts.settle(...args);
                events.push("accepted");
                if (pause && accepted) {
                  yield* runtime.fromPromise((signal) =>
                    peer.send({ id: "pause", token: "after-acceptance" }, signal),
                  );
                }
                return result;
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

        const first = assemble(true);
        await Promise.race([peer.waitForRequests(1), first.result]);
        expect(events).toEqual(accepted ? ["granted", "roll", "accepted"] : ["granted", "roll"]);
        await first.cancel();
        store.reopen();
        if (accepted) {
          await expect(assemble(false, "different-operation").result).rejects.toThrow(
            "Replay request mismatch at 0",
          );
          expect(rollCalls).toBe(1);
          expect(cardCalls).toBe(0);
        }
        const result = await assemble(false).result;
        if (accepted) {
          expect(result).toEqual({
            state: "completed",
            value: {
              roll: failed ? { ok: false, error: { code: "empty-deck" } } : { ok: true, value: 1 },
              card: { suit: "hearts", rank: 7 },
            },
          });
          store.reopen();
          await expect(assemble(false).result).resolves.toEqual(result);
          expect(cardCalls).toBe(1);
        } else {
          expect(result.state).toBe("occupied");
          expect(cardCalls).toBe(0);
        }
        expect(rollCalls).toBe(1);
      });
    }
  }
});
