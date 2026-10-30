import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Work } from "@standard-durability/core";
import { activateJournal, createRecovery, JournalConflict } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, installGuestRetention } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  for (const retained of [false, true]) {
    for (const seam of ["activation", "registration", "attempt"] as const) {
      it(`${runtime.name}: reactivates stale ${seam} in one run (retained ${retained})`, async () => {
        const store = createSqliteJournalRig<unknown, string, string, string, unknown, Y>({
          program: "stale:v1",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        const journal = store.open();
        let pendingId = "";
        let conflicted = false;
        let deliveries = 0;
        const result = await start(function* () {
          const recovery = createRecovery(runtime.composition, {
            name: "stale-recovery",
            program: "stale:v1",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* (scope) {
                yield* scope.ensure(function* () {
                  yield "cleanup";
                });
                return yield "work";
              });
            },
          });
          const initial = yield* activateJournal(runtime.composition, recovery.operations, journal);
          if (initial.state !== "parked") {
            throw new Error("Expected initial boundary");
          }
          pendingId = initial.pending.id;
          yield* recovery.around({
            *recover(args, next) {
              const recovered = yield* next(...args);
              if (seam === "activation" && !conflicted) {
                conflicted = true;
                // A second actor registers after recovery read but before park writes.
                yield* journal.interactions.register(pendingId);
              }
              return recovered;
            },
          });
          const host = createHosting(runtime.composition, {
            name: "stale-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            interactions: journal.interactions,
            *handle() {
              deliveries++;
              return { ok: true as const, value: "delivered" };
            },
          });
          yield* host.around({
            *deliveryMode([request]) {
              if (seam !== "activation" && !conflicted) {
                conflicted = true;
                yield* journal.cancellation.request(pendingId, "external stop");
              }

              if (request === "cleanup" || seam === "activation") {
                return "wait";
              }
              return seam === "registration" ? "wait" : "execute";
            },
          });
          if (retained) {
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
          }
          return yield* host.operations.run();
        });
        expect(conflicted).toBe(true);
        expect(deliveries).toBe(0);
        expect(result.state).toBe("waiting");
        if (result.state !== "waiting") {
          throw new Error("Expected current wait");
        }
        expect(result.pending.request).toBe(seam === "activation" ? "work" : "cleanup");
        if (seam !== "activation") {
          expect(result.pending.id).not.toBe(pendingId);
        }
      });
    }
    for (const failure of ["handler", "settlement"] as const) {
      it(`${runtime.name}: never retries ${failure} after delivery (retained ${retained})`, async () => {
        const store = createSqliteJournalRig<unknown, string, string, string, unknown, Y>({
          program: "delivery:v1",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        const journal = store.open();
        let deliveries = 0;
        const run = start(function* () {
          const recovery = createRecovery(runtime.composition, {
            name: "delivery-recovery",
            program: "delivery:v1",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* () {
                return yield "work";
              });
            },
          });
          const host = createHosting(runtime.composition, {
            name: "delivery-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            *handle() {
              deliveries++;
              if (failure === "handler") {
                throw new JournalConflict("Handler failure must escape");
              }
              const state = yield* journal.read();
              if (state.status !== "running" || !state.pending) {
                throw new Error("Expected pending");
              }
              yield* journal.cancellation.request(state.pending.id, "stop during delivery");
              return { ok: true as const, value: "too late" };
            },
          });
          if (retained) {
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
          }
          return yield* host.operations.run();
        });
        await expect(run).rejects.toThrow(
          failure === "handler" ? "Handler failure must escape" : "revoked",
        );
        expect(deliveries).toBe(1);
      });
    }
  }
});
