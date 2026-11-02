import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createRecovery } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, installGuestRetention } from "@sweatpan.ts/hosting";
import { createProtocolRig, createSqliteJournalRig, createLatch } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const wrapper of ["activate", "recover", "none", "shared"] as const) {
    it(`retains only visible live Guests through ${wrapper} middleware`, async () => {
      const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
        program: "retention",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      const journal = store.open();
      const peer = createProtocolRig();
      const competitorsDone = createLatch<void>();
      let acquired = 0;
      let disposed = 0;
      const recovery = createRecovery(runtime.composition, {
        name: "retention-recovery",
        program: "retention",
        matches: isDeepStrictEqual,
        *acquire() {
          acquired++;
          const guest = createScopedGuest<string, string>(function* () {
            yield "first";
            return (yield "second") as string;
          });
          return {
            ...guest,
            *close() {
              disposed++;
              yield* guest.close();
            },
          };
        },
      });
      const host = createHosting(runtime.composition, {
        name: "retention-host",
        recovery: recovery.operations,
        journal,
        attempts: journal.attempts,
        *handle(request: string) {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: request, token: request }, signal),
          );
          return { ok: true, value: reply.body } as const;
        },
      });
      const execution = runtime.start(function* () {
        if (wrapper === "activate") {
          yield* host.around({
            activate(args, next) {
              return runtime.composition.scoped(() => next(...args));
            },
          });
        }
        if (wrapper === "recover") {
          yield* recovery.around({
            recover(args, next) {
              return runtime.composition.scoped(() => next(...args));
            },
          });
        }
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        if (wrapper === "shared") {
          const results = yield* runtime.all([
            () => host.operations.run(),
            function* () {
              yield* runtime.fromPromise(() => peer.waitForRequests(1));
              const first = yield* host.operations.run();
              expect(first.state).toBe("occupied");
              const second = yield* host.operations.run();
              expect(second.state).toBe("occupied");
              expect(disposed).toBe(2);
              competitorsDone.resolve();
              return second;
            },
          ]);
          return results[0];
        }
        return yield* host.operations.run();
      });
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      for (const [index, request] of ["first", "second"].entries()) {
        await Promise.race([
          peer.waitForRequests(index + 1),
          execution.result.then(() => {
            throw new Error("Host ended before delivery");
          }),
        ]);
        if (wrapper === "shared" && index === 0) {
          await Promise.race([competitorsDone.promise, execution.result]);
        }
        peer.reply(request, { status: 200, body: request });
      }
      await expect(execution.result).resolves.toEqual({ state: "completed", value: "second" });
      expect(acquired).toBe(wrapper === "none" ? 1 : 3);
      expect(disposed).toBe(acquired);
    });
  }
});
