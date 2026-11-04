import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Outcome } from "@standard-durability/core";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, installGuestRetention, type HostedResult } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createHostedRecovery, createLatch, createSqliteJournalRig } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const retained of [false, true]) {
    it(`${runtime.name}: cooperative budget yields after acceptance and joined cleanup (retained ${retained})`, async () => {
      const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
        program: "yielding",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      const cleaning = createLatch<void>();
      const release = createLatch<void>();
      let acquisitions = 0;
      let disposals = 0;
      let deliveries = 0;
      let accepted = 0;
      let cleaned = 0;
      function drive(limit: number) {
        const execution = runtime.start(function* (): Operation<HostedResult<string, string>, Y> {
          const recovery = createHostedRecovery(runtime, {
            name: "yielding-recovery",
            program: "yielding",
            matches: isDeepStrictEqual,
            *acquire() {
              acquisitions++;
              const guest = createScopedGuest(function* () {
                const first: unknown = yield "first";
                const second: unknown = yield "second";
                return `${String(first)}:${String(second)}`;
              });
              return {
                ...guest,
                *close() {
                  yield* guest.close();
                  disposals++;
                },
              };
            },
          });
          const host = createHosting(runtime.composition, {
            name: "yielding-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            *handle(request: string): Operation<Outcome<string, string>, Y> {
              deliveries++;
              yield* runtime.composition.ensure(function* () {
                if (request === "first") {
                  cleaning.resolve();
                  yield* runtime.fromPromise(() => release.promise);
                }
                cleaned++;
              });
              return { ok: true, value: request };
            },
          });
          if (retained) {
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
          }
          yield* host.attempts.around({
            *settle(args, next) {
              const result = yield* next(...args);
              accepted++;
              return result;
            },
          });
          const result = yield* runtime.composition.scoped(function* () {
            yield* host.around({
              *continuation() {
                expect(cleaned).toBe(accepted);
                return accepted >= limit
                  ? { action: "yield", reason: "acceptance budget" }
                  : { action: "continue" };
              },
            });
            return yield* host.operations.run();
          });
          expect(yield* host.operations.continuation()).toEqual({ action: "continue" });
          return result;
        });
        void execution.result.catch(() => undefined);
        onTestFinished(async () => {
          release.resolve();
          await execution.cancel();
        });
        return execution;
      }
      await expect(drive(0).result).resolves.toEqual({
        state: "yielded",
        reason: "acceptance budget",
      });
      expect(acquisitions).toBe(0);
      expect(deliveries).toBe(0);
      const first = drive(1);
      let finished = false;
      void first.result.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      await cleaning.promise;
      expect(accepted).toBe(1);
      expect(finished).toBe(false);
      expect(deliveries).toBe(1);
      release.resolve();
      await expect(first.result).resolves.toEqual({
        state: "yielded",
        reason: "acceptance budget",
      });
      expect(disposals).toBe(acquisitions);
      journal = store.reopen();
      await expect(drive(Infinity).result).resolves.toEqual({
        state: "completed",
        value: "first:second",
      });
      expect(deliveries).toBe(2);
      expect(accepted).toBe(2);
      expect(disposals).toBe(acquisitions);
    });
  }
});
