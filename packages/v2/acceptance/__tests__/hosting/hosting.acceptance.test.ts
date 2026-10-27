import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Work, Operation, Outcome } from "@standard-durability/core";
import {
  createRecovery,
  type AttemptGrant,
  type Attempts,
  type RetrySafety,
} from "@sweatpan.ts/durable";
import { createIteratorGuest } from "@sweatpan.ts/execution";
import { createHosting, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function scenario() {
    const journal = createMemoryJournal<{ reservation: string }, string, string, string>({
      program: "reservation",
      equals: isDeepStrictEqual,
    });
    const peer = createProtocolRig();
    const grants: AttemptGrant[] = [];
    let physicalDisposals = 0;
    function host(attempts: Attempts<string, string, string, Y> = journal.attempts) {
      const recovery = createRecovery(runtime.composition, {
        name: "reservation-recovery",
        program: "reservation",
        matches: isDeepStrictEqual,
        *acquire() {
          const guest = createIteratorGuest(function* () {
            const reservation: unknown = yield "reserve";
            if (typeof reservation !== "string") {
              throw new Error("Expected reservation");
            }
            return { reservation };
          });
          return {
            ...guest,
            *close() {
              yield* guest.close();
              physicalDisposals++;
            },
          };
        },
      });
      const hosting = createHosting(runtime.composition, {
        name: "reservation-host",
        recovery: recovery.operations,
        journal,
        attempts,
        *handle(request: string): Operation<Outcome<string, string>, Y> {
          const grant: AttemptGrant = yield* hosting.delivery.expect();
          grants.push(grant);
          // Computation is physically disposed before effect execution begins.
          expect(physicalDisposals).toBeGreaterThanOrEqual(grants.length);
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: grant.attemptId, token: grant.requestId }, signal),
          );
          expect(request).toBe("reserve");
          return { ok: true, value: reply.body } as const;
        },
      });
      return { hosting, recovery };
    }
    function run(
      safety: RetrySafety = "unsafe",
      replace?: AttemptGrant,
      attempts?: Attempts<string, string, string, Y>,
      gates: { beforePark?: Work<void, Y>; beforeBegin?: Work<void, Y> } = {},
    ) {
      const { hosting, recovery } = host(attempts);
      return start(function* () {
        if (gates.beforePark) {
          const gate = gates.beforePark;
          yield* recovery.around({
            *recover(args, next) {
              const recovered = yield* next(...args);
              yield* gate();
              return recovered;
            },
          });
        }
        yield* hosting.around({
          *retrySafety() {
            if (gates.beforeBegin) {
              yield* gates.beforeBegin();
            }
            return safety;
          },
        });
        return yield* hosting.operations.run(replace);
      });
    }
    async function wait(count: number, result: Promise<unknown>) {
      await Promise.race([
        peer.waitForRequests(count),
        result.then(() => {
          throw new Error("Host ended before request");
        }),
      ]);
    }
    return { journal, peer, grants, run, wait };
  }
  describe(`${runtime.name}: hosted attempt sandwich`, () => {
    it("denies competing delivery, replaces explicitly and rejects the old late result", async () => {
      const s = scenario();
      const first = s.run("repeatable");
      await s.wait(1, first.result);
      const original = s.grants[0]!;
      expect(await s.run("repeatable").result).toEqual({ state: "occupied", grant: original });
      expect(s.peer.requests).toHaveLength(1);
      const second = s.run("repeatable", original);
      await s.wait(2, second.result);
      const replacement = s.grants[1]!;
      expect(replacement.requestId).toBe(original.requestId);
      expect(replacement.attemptId).not.toBe(original.attemptId);
      await expect(s.run("repeatable", original).result).rejects.toThrow("replacement conflict");
      s.peer.reply(original.attemptId, { status: 200, body: "stale-reservation" });
      await expect(first.result).rejects.toThrow("Stale attempt grant");
      expect((await start(() => s.journal.read()).result).history).toEqual([]);
      s.peer.reply(replacement.attemptId, { status: 200, body: "reservation-1" });
      const completed = await second.result;
      expectTypeOf(completed).toEqualTypeOf<HostedResult<{ reservation: string }, string>>();
      expect(completed).toEqual({ state: "completed", value: { reservation: "reservation-1" } });
      expect((await start(() => s.journal.read()).result).history).toHaveLength(1);
      expect(await s.run().result).toEqual(completed);
      expect(s.peer.requests).toHaveLength(2);
    });

    for (const originalSafety of ["unsafe", "repeatable"] as const) {
      it(`does not retry when recorded or current policy is unsafe (recorded: ${originalSafety})`, async () => {
        const s = scenario();
        const first = s.run(originalSafety);
        await s.wait(1, first.result);
        s.peer.fail(
          s.grants[0]!.attemptId,
          new Error("Connection lost after service may have acted"),
        );
        await expect(first.result).rejects.toThrow("Connection lost");
        const currentSafety = originalSafety === "unsafe" ? "repeatable" : "unsafe";
        const occupied = await s.run(currentSafety).result;
        expect(occupied.state).toBe("occupied");
        await expect(s.run(currentSafety, s.grants[0]).result).rejects.toThrow("Unsafe attempt");
        expect(s.peer.requests).toHaveLength(1);
        expect((await start(() => s.journal.read()).result).history).toEqual([]);
      });
    }

    for (const safety of ["unsafe", "repeatable"] as const) {
      it(`host shutdown aborts delivery but leaves the workflow recoverable (${safety})`, async () => {
        const s = scenario();
        const first = s.run(safety);
        await s.wait(1, first.result);
        const grant = s.grants[0]!;
        await first.cancel();
        await expect(first.result).rejects.toBeDefined();
        expect(s.peer.aborted).toEqual([grant.attemptId]);
        const snapshot = await start(() => s.journal.read()).result;
        expect(snapshot.status).toBe("running");
        expect(snapshot.history).toEqual([]);
        expect(await s.run(safety).result).toEqual({ state: "occupied", grant });
        expect(s.peer.requests).toHaveLength(1);
        if (safety === "unsafe") {
          await expect(s.run("repeatable", grant).result).rejects.toThrow("Unsafe attempt");
        } else {
          const resumed = s.run("repeatable", grant);
          await s.wait(2, resumed.result);
          expect(s.grants[1]!.requestId).toBe(grant.requestId);
          s.peer.reply(s.grants[1]!.attemptId, { status: 200, body: "reservation-1" });
          expect(await resumed.result).toEqual({
            state: "completed",
            value: { reservation: "reservation-1" },
          });
        }
      });
    }

    for (const boundary of ["beforePark", "beforeBegin"] as const) {
      it(`serializes competing hosts at ${boundary} without duplicate delivery`, async () => {
        const s = scenario();
        const gates = createProtocolRig();
        function run(id: string) {
          let passed = false;
          return s.run("repeatable", undefined, undefined, {
            [boundary]: function* () {
              if (passed) {
                return;
              }
              passed = true;
              yield* runtime.fromPromise((signal) => gates.send({ id, token: "ready" }, signal));
            },
          });
        }
        const first = run("first");
        await Promise.race([gates.waitForRequests(1), first.result]);
        const second = run("second");
        await Promise.race([gates.waitForRequests(2), first.result, second.result]);
        gates.reply("first", { status: 200, body: "commit" });
        await s.wait(1, first.result);
        gates.reply("second", { status: 200, body: "commit" });
        if (boundary === "beforePark") {
          await expect(second.result).rejects.toThrow("revision conflict");
        } else {
          expect(await second.result).toEqual({ state: "occupied", grant: s.grants[0] });
        }
        expect(s.peer.requests).toHaveLength(1);
        s.peer.reply(s.grants[0]!.attemptId, { status: 200, body: "reservation-1" });
        expect(await first.result).toEqual({
          state: "completed",
          value: { reservation: "reservation-1" },
        });
        expect((await start(() => s.journal.read()).result).history).toHaveLength(1);
      });
    }

    it("recovers an accepted result after acknowledgement loss without executing again", async () => {
      const s = scenario();
      const transport: Attempts<string, string, string, Y> = {
        begin: s.journal.attempts.begin,
        *settle(grant, outcome) {
          const accepted = yield* s.journal.attempts.settle(grant, outcome);
          const duplicate = yield* s.journal.attempts.settle(grant, outcome);
          expect(duplicate).toEqual({ ...accepted, duplicate: true });
          yield* runtime.fromPromise(async () => {
            throw new Error("Acceptance acknowledgement lost");
          });
          return accepted;
        },
      };
      const first = s.run("unsafe", undefined, transport);
      await s.wait(1, first.result);
      s.peer.reply(s.grants[0]!.attemptId, { status: 200, body: "reservation-1" });
      await expect(first.result).rejects.toThrow("acknowledgement lost");
      expect(await s.run().result).toEqual({
        state: "completed",
        value: { reservation: "reservation-1" },
      });
      expect(s.peer.requests).toHaveLength(1);
    });

    it("never executes after a lost grant acknowledgement and leaves the attempt occupied", async () => {
      const s = scenario();
      const transport: Attempts<string, string, string, Y> = {
        *begin(...args) {
          yield* s.journal.attempts.begin(...args);
          throw new Error("Grant acknowledgement lost");
        },
        settle: s.journal.attempts.settle,
      };
      await expect(s.run("repeatable", undefined, transport).result).rejects.toThrow(
        "Grant acknowledgement lost",
      );
      expect((await s.run("repeatable").result).state).toBe("occupied");
      expect(s.peer.requests).toEqual([]);
    });
  });
});
