import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Outcome, Work } from "@standard-durability/core";
import { createRecovery, type Attempts } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import {
  createEffectCapabilitiesRig,
  createProtocolRig,
  createSqliteJournalRig,
  type CapabilityRequest,
} from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }

  for (const mode of ["fulfilled", "rejected", "throws", "bare"] as const) {
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
        const effects = createEffectCapabilitiesRig(runtime, "invalid-record");
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
            current = ctx;
            return createScopedGuest(function* () {
              // Models a JS/untyped boundary where the callback result was erased.
              const work = (() => {
                calls++;
                if (mode === "throws") {
                  throw new Error("Delivery failed");
                }
                if (mode === "bare") {
                  return 6;
                }
                return mode === "rejected"
                  ? Promise.reject(new Error("Async callback failed"))
                  : Promise.resolve({ ok: true, value: 6 });
              }) as unknown as () => Outcome<unknown, unknown>;
              return yield* ctx.record(work);
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
          return yield* host.operations.run();
        });
      }
      await expect(assemble().result).rejects.toThrow(
        mode === "throws"
          ? "Delivery failed"
          : mode === "bare"
            ? "Effect work must return an Outcome"
            : "Recorded work must return a synchronous value",
      );
      expect(settlements).toBe(0);
      const snapshot = await start(() => store.open().read()).result;
      expect(snapshot.frontier.position).toBe(0);
      store.reopen();
      expect((await assemble().result).state).toBe("occupied");
      expect(calls).toBe(1);
    });
  }

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

        function assemble(pause: boolean) {
          const effects = createEffectCapabilitiesRig(runtime, "recording");
          const journal = store.open();
          let granted = false;
          let current: ReturnType<typeof acquireGrant> | undefined;
          function acquireGrant() {
            return effects.grant({}, { record: true });
          }
          function rollDice() {
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
              current = grant;
              return createScopedGuest(function* () {
                const roll = yield* grant.record(rollDice);
                if (roll.ok) {
                  expectTypeOf(roll.value).toEqualTypeOf<number>();
                } else {
                  expectTypeOf(roll.error).toEqualTypeOf<{ code: string }>();
                }
                const card = yield* grant.record(() => {
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
            return yield* host.operations.run();
          });
        }

        const first = assemble(true);
        await Promise.race([peer.waitForRequests(1), first.result]);
        expect(events).toEqual(accepted ? ["granted", "roll", "accepted"] : ["granted", "roll"]);
        await first.cancel();
        store.reopen();
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
