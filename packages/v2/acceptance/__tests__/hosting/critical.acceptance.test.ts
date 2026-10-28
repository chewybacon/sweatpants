import { isDeepStrictEqual } from "node:util";
import { describe, expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { createRecovery, type ResolutionGrant } from "@sweatpan.ts/durable";
import { createScopedGuest } from "@sweatpan.ts/execution";
import { createHosting, installAttemptCancellation, type HostedResult } from "@sweatpan.ts/hosting";
import { createMemoryJournal } from "@sweatpan.ts/storage-memory";
import { createNotificationRig, createProtocolRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

function* ask(request: string): Operation<string, string> {
  const value: unknown = yield request;
  if (typeof value !== "string") {
    throw new Error("Expected text reply");
  }
  return value;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution;
  }
  function scenario() {
    const journal = createMemoryJournal<{ id: string }, string, string, string>({
      program: "critical-acquire",
      equals: isDeepStrictEqual,
    });
    const peer = createProtocolRig();
    const notifications = createNotificationRig();
    function assemble() {
      const recovery = createRecovery(runtime.composition, {
        name: "critical-recovery",
        program: "critical-acquire",
        matches: isDeepStrictEqual,
        *acquire() {
          return createScopedGuest(function* (scope) {
            const hold = yield* scope.critical(function* () {
              const id = yield* ask("reserve");
              yield* scope.ensure(function* () {
                yield* ask(`release:${id}`);
              });
              const confirmation = yield* scope.scoped(function* (child) {
                return yield* child.critical(function* () {
                  return { text: yield* ask("confirm") };
                });
              });
              expectTypeOf(confirmation).toEqualTypeOf<{ text: string }>();
              yield* ask("seal");
              return { id };
            });
            expectTypeOf(hold).toEqualTypeOf<{ id: string }>();
            yield* ask("use");
            return hold;
          });
        },
      });
      const host = createHosting(runtime.composition, {
        name: "critical-host",
        recovery: recovery.operations,
        journal,
        attempts: journal.attempts,
        interactions: journal.interactions,
        attemptControl: journal.attemptControl,
        *handle(request: string): Operation<Outcome<string, string>, Y> {
          const reply = yield* runtime.fromPromise((signal) =>
            peer.send({ id: request, token: "reservation" }, signal),
          );
          return { ok: true, value: reply.body };
        },
      });
      return host;
    }
    function invoke<T>(work: (host: ReturnType<typeof assemble>) => Operation<T, Y>) {
      const host = assemble();
      return start(function* () {
        yield* host.around({
          *deliveryMode([request]) {
            return request === "confirm" || request === "seal" ? "wait" : "execute";
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
        return yield* work(host);
      });
    }
    return {
      journal,
      peer,
      notifications,
      run: () => invoke((host) => host.operations.run()),
      cancel: (id: string, reason = "deadline") =>
        invoke((host) => host.operations.cancel(id, reason)).result,
      answer: (
        grant: ResolutionGrant,
        outcome: Outcome<string, string> = { ok: true, value: "ok" },
      ) => invoke((host) => host.operations.answer(grant, outcome)).result,
    };
  }
  describe(`${runtime.name}: critical logical regions`, () => {
    for (const cancel of [false, true]) {
      it(`preserves acquisition, nested masks and cleanup registration across replay (cancel: ${cancel})`, async () => {
        const s = scenario();
        const live = s.run();
        await Promise.race([s.peer.waitForRequests(1), live.result]);
        const snapshot = await start(() => s.journal.read()).result;
        if (snapshot.status !== "running" || !snapshot.pending) {
          throw new Error("Expected acquisition");
        }
        const acquisition = snapshot.pending;
        expect(acquisition.scope?.phase).toBe("body");
        expect(acquisition.scope?.critical).toBeDefined();
        if (cancel) {
          const intent = await s.cancel(acquisition.id);
          expect(intent.attempt).toBeUndefined();
          expect(s.peer.aborted).toEqual([]);
          expect((await start(() => s.journal.read()).result).cancellation?.reason).toBe(
            "deadline",
          );
        }
        s.peer.reply("reserve", { status: 200, body: "hold-7" });
        const confirmation = await live.result;
        expectTypeOf(confirmation).toEqualTypeOf<HostedResult<{ id: string }, string>>();
        if (confirmation.state !== "waiting") {
          throw new Error("Expected confirmation");
        }
        expect(confirmation.pending.request).toBe("confirm");
        expect(confirmation.pending.scope?.critical).toBe(acquisition.scope?.critical);
        expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve"]);
        if (cancel) {
          await s.cancel(acquisition.id, "repeated");
        }
        const recovered = await s.run().result;
        expect(recovered).toEqual(confirmation);
        await s.answer(confirmation.grant);
        const seal = await s.run().result;
        if (seal.state !== "waiting") {
          throw new Error("Expected outer mask to remain active");
        }
        expect(seal.pending.request).toBe("seal");
        expect(seal.pending.scope?.critical).toBe(acquisition.scope?.critical);
        await s.answer(seal.grant);
        const exiting = s.run();
        await Promise.race([s.peer.waitForRequests(2), exiting.result]);
        if (!cancel) {
          expect(s.peer.requests[1]!.id).toBe("use");
          s.peer.reply("use", { status: 200, body: "used" });
          await Promise.race([s.peer.waitForRequests(3), exiting.result]);
        }
        expect(s.peer.requests.at(-1)!.id).toBe("release:hold-7");
        s.peer.reply("release:hold-7", { status: 200, body: "released" });
        const expected = cancel
          ? { state: "cancelled", reason: "deadline" }
          : { state: "completed", value: { id: "hold-7" } };
        expect(await exiting.result).toEqual(expected);
        expect(await s.run().result).toEqual(expected);
        expect(s.notifications.subscriptions).toBe(0);
        const final = await start(() => s.journal.read()).result;
        expect(final.history.map((entry) => entry.request)).toEqual(
          cancel
            ? ["reserve", "confirm", "seal", "release:hold-7"]
            : ["reserve", "confirm", "seal", "use", "release:hold-7"],
        );
        expect(final.history.at(-1)!.scope?.critical).toBeUndefined();
      });
    }
    it("drains registered compensation when a masked operation fails after cancellation", async () => {
      const s = scenario();
      const live = s.run();
      await Promise.race([s.peer.waitForRequests(1), live.result]);
      const snapshot = await start(() => s.journal.read()).result;
      if (snapshot.status !== "running" || !snapshot.pending) {
        throw new Error("Expected acquisition");
      }
      await s.cancel(snapshot.pending.id);
      s.peer.reply("reserve", { status: 200, body: "hold-7" });
      const confirmation = await live.result;
      if (confirmation.state !== "waiting") {
        throw new Error("Expected confirmation");
      }
      await s.answer(confirmation.grant, { ok: false, error: "Confirmation rejected" });
      const exiting = s.run();
      await Promise.race([s.peer.waitForRequests(2), exiting.result]);
      expect(s.peer.requests[1]!.id).toBe("release:hold-7");
      s.peer.reply("release:hold-7", { status: 200, body: "released" });
      expect(await exiting.result).toEqual({
        state: "cancelled",
        reason: "deadline",
        failure: "Confirmation rejected",
      });
    });
    it("allows physical host shutdown while leaving a critical unsafe attempt occupied", async () => {
      const s = scenario();
      const live = s.run();
      await Promise.race([s.peer.waitForRequests(1), live.result]);
      const snapshot = await start(() => s.journal.read()).result;
      if (snapshot.status !== "running" || !snapshot.pending) {
        throw new Error("Expected acquisition");
      }
      await s.cancel(snapshot.pending.id);
      await live.cancel();
      expect(s.peer.aborted).toEqual(["reserve"]);
      expect(s.notifications.subscriptions).toBe(0);
      const recovered = await s.run().result;
      expect(recovered.state).toBe("occupied");
      expect(s.peer.requests.map((request) => request.id)).toEqual(["reserve"]);
      expect((await start(() => s.journal.read()).result).cancellation?.reason).toBe("deadline");
    });
  });
});
