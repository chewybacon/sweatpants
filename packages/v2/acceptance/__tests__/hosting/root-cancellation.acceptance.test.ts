import { readJournal } from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createRecovery, type AttemptGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import {
  createHosting,
  installGuestRetention,
  installAttemptCancellation,
  type HostedResult,
} from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createNotificationRig, createProtocolRig, createLatch } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

type Request = "reserve" | "approve" | "child-close" | "release" | "audit";
function* ask(request: Request): Operation<string, Request> {
  const value: unknown = yield request;
  if (typeof value !== "string") {
    throw new Error("Expected response text");
  }
  return value;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const lifetime of ["recover", "retain"] as const) {
    function start<T>(work: Work<T, Y>) {
      const execution = runtime.start(work);
      void execution.result.catch(() => undefined);
      onTestFinished(() => execution.cancel());
      return execution;
    }
    function scenario(liveApproval = false) {
      const journal = createMemoryJournal<{ approval: string }, Request, string, string>({
        program: "reservation-cancellation",
        equals: isDeepStrictEqual,
      });
      const peer = createProtocolRig();
      const notifications = createNotificationRig();
      const grants: AttemptGrant[] = [];
      let afterAcceptance: Work<void, Y> | undefined;
      let cleanupVisits = 0;
      let cancellationCalls = 0;
      function assemble() {
        const recovery = createRecovery(runtime.composition, {
          name: "reservation-recovery",
          program: "reservation-cancellation",
          matches: isDeepStrictEqual,
          *acquire() {
            // This is nested lexical cleanup, not yet an independently scheduled child task.
            return createScopedGuest(function* (scope) {
              yield* ask("reserve");
              yield* scope.ensure(function* () {
                yield* ask("audit");
              });
              yield* scope.ensure(function* () {
                yield* ask("release");
              });
              return yield* scope.scoped(function* (child) {
                yield* child.ensure(function* () {
                  cleanupVisits++;
                  yield* ask("child-close");
                });
                return { approval: yield* ask("approve") };
              });
            });
          },
        });
        const host = createHosting(runtime.composition, {
          name: "reservation-host",
          journal,
          recovery: recovery.operations,
          attempts: {
            begin: (...args) => journal.attempts.begin(...args),
            *settle(...args: Parameters<typeof journal.attempts.settle>) {
              const receipt = yield* journal.attempts.settle(...args);
              const pause = afterAcceptance;
              afterAcceptance = undefined;
              if (pause) {
                yield* pause();
              }
              return receipt;
            },
          },
          interactions: journal.interactions,
          *handle(request: Request): Operation<Outcome<string, string>, Y> {
            grants.push(yield* host.delivery.expect());
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: request, token: "reservation" }, signal),
            );
            return reply.status === 200
              ? { ok: true, value: reply.body }
              : { ok: false, error: reply.body };
          },
        });
        return { host, recovery };
      }
      function runHost<T>(call: (host: ReturnType<typeof assemble>["host"]) => Operation<T, Y>) {
        const { host, recovery } = assemble();
        return start(function* () {
          if (lifetime === "retain") {
            yield* installGuestRetention(runtime.composition, host, recovery, journal);
          }
          yield* recovery.execution.around({
            *cancel([reason], next) {
              cancellationCalls++;
              const turn = yield* next(reason);
              // Repeating cancellation must preserve the current cleanup boundary.
              expect(yield* next("repeated")).toEqual(turn);
              return turn;
            },
          });
          yield* installAttemptCancellation(runtime, host, journal.attemptControl, {
            *subscribe(grant) {
              const subscription = notifications.subscribe(grant.attemptId);
              yield* runtime.composition.ensure(function* () {
                subscription.close();
              });
              return subscription.signal;
            },
            *publish(grant) {
              notifications.publish(grant.attemptId);
            },
          });
          yield* host.around({
            *deliveryMode([request]) {
              return request === "release" || (request === "approve" && !liveApproval)
                ? "wait"
                : "execute";
            },
          });
          return yield* call(host);
        });
      }
      return {
        journal,
        peer,
        grants,
        notifications,
        afterAcceptance(work: Work<void, Y>) {
          afterAcceptance = work;
        },
        get cancellationCalls() {
          return cancellationCalls;
        },
        get cleanupVisits() {
          return cleanupVisits;
        },
        run: () => runHost((host) => host.operations.run()),
        cancel: (id: string, reason = "deadline") =>
          runHost((host) => host.operations.cancel(id, reason)).result,
        answer: (
          grant: Parameters<ReturnType<typeof assemble>["host"]["operations"]["answer"]>[0],
          outcome: Outcome<string, string>,
        ) => runHost((host) => host.operations.answer(grant, outcome)).result,
      };
    }

    describe(`${runtime.name} ${lifetime}: replayed root cancellation`, () => {
      it("reconciles cancellation committed after acceptance before resuming the original host", async () => {
        const s = scenario();
        const accepted = createLatch<void>();
        const release = createLatch<void>();
        onTestFinished(() => release.resolve());
        s.afterAcceptance(function* () {
          accepted.resolve();
          yield* runtime.fromPromise(() => release.promise);
        });
        const original = s.run();
        await Promise.race([s.peer.waitForRequests(1), original.result]);
        s.peer.reply("reserve", { status: 200, body: "hold" });
        await Promise.race([accepted.promise, original.result]);
        // A competing host advances accepted history to the next parked boundary.
        const competitor = await s.run().result;
        if (competitor.state !== "waiting") {
          throw new Error("Expected approval wait");
        }
        await s.cancel(competitor.pending.id);
        release.resolve();
        await Promise.race([s.peer.waitForRequests(2), original.result]);
        expect(s.peer.requests.map(({ id }) => id)).toEqual(["reserve", "child-close"]);
        s.peer.reply("child-close", { status: 200, body: "closed" });
        const cleanup = await original.result;
        if (cleanup.state !== "waiting") {
          throw new Error("Expected release wait");
        }
        await s.answer(cleanup.grant, { ok: true, value: "released" });
        const final = s.run();
        await Promise.race([s.peer.waitForRequests(3), final.result]);
        s.peer.reply("audit", { status: 200, body: "audited" });
        expect(await final.result).toMatchObject({ state: "cancelled", reason: "deadline" });
        expect(s.peer.requests.map(({ id }) => id)).toEqual(["reserve", "child-close", "audit"]);
      });

      for (const failedRelease of [false, true]) {
        it(`unwinds nested cleanup, parks, recovers and retains terminal disposition (release fails: ${failedRelease})`, async () => {
          const s = scenario();
          const initial = s.run();
          await Promise.race([s.peer.waitForRequests(1), initial.result]);
          s.peer.reply("reserve", { status: 200, body: "hold-1" });
          const approval = await initial.result;
          expectTypeOf(approval).toEqualTypeOf<HostedResult<{ approval: string }, Request>>();
          if (approval.state !== "waiting") {
            throw new Error("Expected approval wait");
          }
          expect(s.cleanupVisits).toBe(0);
          if (failedRelease) {
            await start(() =>
              s.journal.interactions.invalidate(approval.grant, "participant stopped"),
            ).result;
          }
          const cancellation = await s.cancel(approval.pending.id);
          if (failedRelease) {
            expect(
              await start(() => s.journal.interactions.invalidate(approval.grant, "repeat")).result,
            ).toEqual({
              state: "invalidated",
              reason: "participant stopped",
            });
          }
          expect(cancellation.position).toBe(1);
          expect(s.cleanupVisits).toBe(0);
          await expect(s.answer(approval.grant, { ok: true, value: "too late" })).rejects.toThrow(
            "revoked",
          );
          const unwinding = s.run();
          await Promise.race([s.peer.waitForRequests(2), unwinding.result]);
          expect(s.peer.requests.map(({ id }) => id)).toEqual(["reserve", "child-close"]);
          s.peer.reply("child-close", { status: 200, body: "child closed" });
          const release = await unwinding.result;
          if (release.state !== "waiting") {
            throw new Error("Expected cleanup wait");
          }
          expect(release.pending.request).toBe("release");
          expect(release.pending.id).not.toBe(approval.pending.id);
          const visits = s.cleanupVisits;
          expect(await s.cancel(approval.pending.id, "repeat")).toEqual(cancellation);
          expect(s.cleanupVisits).toBe(visits);
          await s.answer(
            release.grant,
            failedRelease
              ? { ok: false, error: "Release failed" }
              : { ok: true, value: "released" },
          );
          const resumed = s.run();
          await Promise.race([s.peer.waitForRequests(3), resumed.result]);
          expect(s.peer.requests.map(({ id }) => id)).toEqual(["reserve", "child-close", "audit"]);
          s.peer.reply("audit", { status: 200, body: "audited" });
          const expected = {
            state: "cancelled",
            reason: "deadline",
            failure: failedRelease ? "Release failed" : undefined,
          };
          expect(await resumed.result).toEqual(expected);
          expect(s.cancellationCalls).toBe(lifetime === "retain" ? 2 : 4);
          const finalVisits = s.cleanupVisits;
          expect(await s.run().result).toEqual(expected);
          expect(s.cleanupVisits).toBe(finalVisits);
          const snapshot = await start(() => readJournal(s.journal)).result;
          expect(snapshot.history.map(({ request }) => request)).toEqual([
            "reserve",
            "child-close",
            "release",
            "audit",
          ]);
          expect(snapshot.status).toBe("cancelled");
          expect(s.notifications.subscriptions).toBe(0);
        });
      }

      for (const dropped of [false, true]) {
        it(`atomically revokes live approval and preserves fresh cleanup authority (notification lost: ${dropped})`, async () => {
          const s = scenario(true);
          s.notifications.drop = dropped;
          const initial = s.run();
          await Promise.race([s.peer.waitForRequests(1), initial.result]);
          s.peer.reply("reserve", { status: 200, body: "hold-1" });
          await Promise.race([s.peer.waitForRequests(2), initial.result]);
          const approval = s.grants[1]!;
          await s.cancel(approval.requestId);
          if (dropped) {
            s.peer.reply("approve", { status: 200, body: "late approval" });
            await expect(initial.result).rejects.toThrow("revoked");
          } else {
            await expect(initial.result).rejects.toBeDefined();
            expect(s.peer.aborted).toEqual(["approve"]);
          }
          const cleanup = s.run();
          await Promise.race([s.peer.waitForRequests(3), cleanup.result]);
          const cleanupGrant = s.grants[2]!;
          expect(cleanupGrant.requestId).not.toBe(approval.requestId);
          await s.cancel(approval.requestId, "again");
          expect(
            (await start(() => s.journal.attemptControl.inspect(cleanupGrant)).result).state,
          ).toBe("active");
          s.peer.reply("child-close", { status: 200, body: "closed" });
          const release = await cleanup.result;
          if (release.state !== "waiting") {
            throw new Error("Expected release wait");
          }
          await s.answer(release.grant, { ok: true, value: "released" });
          const final = s.run();
          await Promise.race([s.peer.waitForRequests(4), final.result]);
          s.peer.reply("audit", { status: 200, body: "audited" });
          expect(await final.result).toEqual({ state: "cancelled", reason: "deadline" });
        });
      }

      it("rejects stale cancellation after an answer wins without revoking the accepted answer", async () => {
        const s = scenario();
        const initial = s.run();
        await Promise.race([s.peer.waitForRequests(1), initial.result]);
        s.peer.reply("reserve", { status: 200, body: "hold-1" });
        const approval = await initial.result;
        if (approval.state !== "waiting") {
          throw new Error("Expected approval wait");
        }
        await s.answer(approval.grant, { ok: true, value: "approved" });
        await expect(s.cancel(approval.pending.id)).rejects.toThrow("Stale");
        expect((await start(() => readJournal(s.journal)).result).cancellation).toBeUndefined();
      });
    });
  }
});
