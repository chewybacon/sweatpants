import { v8Serializer } from "@sweatpan.ts/storage-sqlite";
import { childHostingResult, type ChildHostingResult } from "@sweatpan.ts/hosting";
import {
  createHostedRecovery as createRecovery,
  createNotificationRig,
  createLatch,
  createProtocolRig,
  createSqliteJournalRig,
  readJournal,
} from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Outcome, Work } from "@standard-durability/core";
import { defineEffect, type Branch, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createScopedGuest,
  type LogicalScope,
  type ScopeInstruction,
} from "@sweatpan.ts/execution";
import {
  type AttemptRevocation,
  type OwnedChild,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  createOwnedRace,
  installAttemptCancellation,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

import { forEachRuntime } from "../runtime/assembly.ts";

const answer = defineEffect({ key: "race.answer", context: z.string(), response: z.string() });
const cleanup = defineEffect({ key: "race.cleanup", context: z.string(), response: z.string() });
interface Context {
  readonly scope: LogicalScope;
  readonly ask: typeof answer.call;
  readonly cleanup: typeof cleanup.call;
}
type Factory = Branch<Context, CapabilityRequest | ScopeInstruction>;
type Result = Outcome<string, unknown>;
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution.result;
  }
  function scenario(
    protectedIndex?: number,
    live?: number,
    cleanupBarrier = false,
    holdWinner = false,
  ) {
    let rejectRevocation = false;
    const winnerCommitted = createLatch<void>();
    const releaseWinner = createLatch<void>();
    onTestFinished(() => releaseWinner.resolve());
    const revocations: AttemptRevocation[] = [];
    const committed = runtime.createSignal<AttemptRevocation>();
    const relayReady = createLatch<void>();
    let stopped = new AbortController();
    const failures: { index: number; error: unknown }[] = [];
    const interrupted = createLatch<void>();
    const peer = createProtocolRig();
    const notifications = createNotificationRig();
    const store = createSqliteJournalRig<Result, CapabilityRequest, unknown, string, unknown, Y>({
      program: "race-parent:v1",
      equals: isDeepStrictEqual,
      serialization: {
        *resolve() {
          return {
            ...v8Serializer,
            encode(value: unknown) {
              if (
                rejectRevocation &&
                typeof value === "object" &&
                value !== null &&
                "revoked" in value
              ) {
                throw new Error("Revocation encoding failed");
              }
              return v8Serializer.encode(value);
            },
          };
        },
      },
      revocations: committed,
    });
    onTestFinished(() => store.close());
    let journal = store.open();
    type Child = OwnedChild<unknown, CapabilityRequest, unknown, string, unknown, Y>;
    let children: Child[] = [];
    // The relay owns an independent native root, rather than the group driver's lifetime.
    const relayTask = runtime.start(function* () {
      const subscription = yield* committed;
      relayReady.resolve();
      while (true) {
        const item = yield* subscription.next();
        if (item.done) {
          return;
        }
        const target = item.value;
        revocations.push(target);
        const child = children.find(({ journal }) => journal.id === target.execution);
        if (!child) {
          throw new Error("Unknown relay target");
        }
        expect((yield* child.journal.attemptControl.inspect(target.grant)).state).toBe(
          "invalidated",
        );
        yield* notifications.driver(runtime).publish(target.grant);
      }
    });
    void relayTask.result.catch(() => undefined);
    onTestFinished(() => relayTask.cancel());
    const relay = relayTask.result;
    const waits = new Map<number, { grant: ResolutionGrant; effect: string }>();
    const visits = [0, 0, 0];
    let parentWait: ResolutionGrant | undefined;
    let boundary = "";
    let paused: number | undefined;
    function run() {
      return start(function* () {
        // Signals drop before subscription: establish the receiver before enabling writers.
        yield* runtime.fromPromise(() => relayReady.promise);
        const effects = createEffectCapabilities(runtime, "race-effects");
        const owned = createOwnedRace<Context, CapabilityRequest | ScopeInstruction, Y>(
          runtime,
          "race.group",
        );
        const grant = effects.grant({ race: owned.effect, cleanup });
        const recovery = createRecovery<Result, CapabilityRequest, Y, unknown, string>(runtime, {
          name: "race-parent-recovery",
          program: "race-parent:v1",
          matches: isDeepStrictEqual,
          *acquire() {
            const race = yield* owned.acquire();
            return createScopedGuest(function* (scope) {
              yield* scope.ensure(function* () {
                yield* grant.capabilities.cleanup("parent");
              });
              function branch(index: number) {
                return function* (ctx: Context) {
                  yield* ctx.scope.ensure(function* () {
                    yield* ctx.cleanup(`child-${index}`);
                  });
                  return protectedIndex === index
                    ? yield* ctx.scope.critical(() => ctx.ask(`child-${index}`))
                    : yield* ctx.ask(`child-${index}`);
                };
              }
              const result = yield* race(
                ...(cleanupBarrier ? [branch(0), branch(1), branch(2)] : [branch(0), branch(1)]),
              );
              expectTypeOf(result).toEqualTypeOf<Result>();
              return result;
            });
          },
        });
        function* drive(
          child: Child,
          factory: Factory,
          index: number,
        ): Operation<ChildHostingResult, Y> {
          children[index] = child;
          boundary = child.link.requestId;
          if (paused === index) {
            return false;
          }
          const childGrant = effects.grant({ answer, cleanup });
          const childRecovery = createRecovery(runtime, {
            name: `race-child-recovery:${index}`,
            program: child.link.program,
            matches: isDeepStrictEqual,
            *acquire() {
              visits[index] = visits[index]! + 1;
              return createScopedGuest((scope) =>
                factory({
                  scope,
                  ask: childGrant.capabilities.answer,
                  cleanup: childGrant.capabilities.cleanup,
                }),
              );
            },
          });
          const host = createHosting(runtime.composition, {
            name: `race-child-host:${index}`,
            journal:
              holdWinner && index === 1
                ? {
                    ...child.journal,
                    *complete(...args: Parameters<typeof child.journal.complete>) {
                      yield* child.journal.complete(...args);
                      winnerCommitted.resolve();
                      yield* runtime.fromPromise(() => releaseWinner.promise);
                    },
                  }
                : child.journal,
            recovery: childRecovery.operations,
            attempts: child.journal.attempts,
            interactions: child.journal.interactions,
            handle: childGrant.handle,
          });
          yield* host.around(childGrant.admission);
          yield* effects.install(answer, function* (context) {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: context, token: "live" }, signal),
            );
            return { ok: true, value: reply.body };
          });
          yield* effects.install(cleanup, function* (context) {
            const reply = yield* runtime.fromPromise((signal) =>
              peer.send({ id: `cleanup:${context}`, token: "cleanup" }, signal),
            );
            return { ok: true, value: reply.body };
          });
          yield* installAttemptCancellation(
            runtime,
            host,
            child.journal.attemptControl,
            notifications.driver(runtime),
          );
          yield* host.around({
            *deliveryMode([request]) {
              return (index === live && request.effect === answer.id) ||
                (cleanupBarrier && index === 2 && request.effect === cleanup.id)
                ? "execute"
                : "wait";
            },
          });
          // This assembly joins failed branches without cancelling independent siblings.
          // Preserve failures for its owner; never convert them to terminal success or retry IO.
          const result = cleanupBarrier
            ? yield* runtime.composition.catchError(
                () =>
                  index === 2
                    ? runtime.withSignal(stopped.signal, () => host.operations.run())
                    : host.operations.run(),
                function* (error) {
                  failures.push({ index, error });
                  if (index === 0) {
                    interrupted.resolve();
                  }
                  return undefined;
                },
              )
            : yield* host.operations.run();
          if (!result) {
            return { state: "blocked", reason: "unknown" };
          }
          if (result.state === "waiting") {
            waits.set(index, { grant: result.grant, effect: result.pending.request.effect });
          } else {
            waits.delete(index);
          }
          return childHostingResult(result);
        }
        const host = createHosting(runtime.composition, {
          name: "race-parent-host",
          journal,
          recovery: recovery.operations,
          attempts: journal.attempts,
          interactions: journal.interactions,
          handle: grant.handle,
        });
        yield* host.around(grant.admission);
        yield* host.around({
          *deliveryMode() {
            return "wait";
          },
        });
        yield* owned.install({
          host,
          journal,
          recovery,
          run: drive,
        });
        yield* installGuestRetention(runtime.composition, host, recovery, journal);
        const result = yield* host.operations.run();
        if (result.state === "waiting") {
          parentWait = result.grant;
        }
        return result;
      });
    }
    function reply(
      index: number,
      outcome: Outcome<unknown, unknown> = { ok: true, value: "done" },
      transportError?: string,
    ) {
      return start(() =>
        children[index]!.journal.interactions.answer(
          waits.get(index)!.grant,
          transportError === undefined
            ? { ok: true, value: outcome }
            : { ok: false, error: transportError },
        ),
      );
    }
    return {
      run,
      relay,
      stopRelay: () => relayTask.cancel(),
      revocations,
      rejectRevocation(value: boolean) {
        rejectRevocation = value;
      },
      winnerCommitted,
      releaseWinner,
      failures,
      interrupted,
      stopCleanup: () => stopped.abort(new Error("Execution stopped")),
      peer,
      notifications,
      waits,
      visits,
      reply,
      get children() {
        return children;
      },
      get journal() {
        return journal;
      },
      get boundary() {
        return boundary;
      },
      pause(index?: number) {
        paused = index;
      },
      reopen() {
        stopped = new AbortController();
        journal = store.reopen();
        children = [];
        waits.clear();
        parentWait = undefined;
      },
      cancel() {
        return start(() => journal.cancellation.request(boundary, "stop parent"));
      },
      finish() {
        return start(() =>
          journal.interactions.answer(parentWait!, {
            ok: true,
            value: { ok: true, value: "parent closed" },
          }),
        );
      },
      snapshot() {
        return start(() => readJournal(journal));
      },
      async choose(index: number, value: Outcome<unknown, unknown>) {
        await reply(index, value);
        await run();
        expect(waits.get(index)!.effect).toBe(cleanup.id);
        paused = 1 - index; // Drive the terminal winner without activating the stale loser.
        await reply(index);
        expect((await run()).state).toBe("child");
        paused = undefined;
      },
    };
  }
  it(`${runtime.name}: race join policy cannot change on reacquisition`, async () => {
    const s = scenario();
    await s.run();
    await expect(
      start(() =>
        s.journal.ensureChildren(s.boundary, {
          join: "all",
          children: s.children.map(({ link }) => ({ program: link.program, input: link.input })),
          outcome: (values) => ({ ok: true, value: values }),
        }),
      ),
    ).rejects.toThrow("Owned child definition differs");
    await s.choose(0, { ok: true, value: "winner" });
    await s.run();
    await s.reply(1);
    await s.run();
    await s.finish();
    await expect(s.run()).resolves.toMatchObject({
      state: "completed",
      value: { ok: true, value: "winner" },
    });
  });
  for (const winner of [0, 1]) {
    for (const failure of [false, true]) {
      it(`${runtime.name}: race pins child ${winner}, failure value ${failure}, fences losers and drains cleanup across reopen`, async () => {
        const s = scenario();
        await s.run();
        const loser = 1 - winner;
        const loserChild = s.children[loser]!;
        const stale = s.waits.get(loser)!.grant;
        const value = failure
          ? { ok: false as const, error: { code: "declined" } }
          : { ok: true as const, value: "winner" };
        await s.choose(winner, value);
        expect((await s.snapshot()).history).toHaveLength(0);
        await expect(
          start(() =>
            loserChild.journal.interactions.answer(stale, {
              ok: true,
              value: { ok: true, value: "late" },
            }),
          ),
        ).rejects.toThrow("revoked");
        const winnerVisits = s.visits[winner];
        s.reopen();
        await s.run();
        expect(s.visits[winner]).toBe(winnerVisits);
        expect(s.waits.get(loser)!.effect).toBe(cleanup.id);
        await s.reply(loser);
        expect((await s.run()).state).toBe("waiting");
        const snapshot = await s.snapshot();
        expect(snapshot.history).toHaveLength(1);
        expect(snapshot.history[0]!.outcome).toEqual({
          ok: true,
          value: { ok: true, value: [value] },
        });
        await s.finish();
        await expect(s.run()).resolves.toEqual({ state: "completed", value });
        s.reopen();
        await expect(s.run()).resolves.toEqual({ state: "completed", value });
      });
    }
  }
  for (const afterWinner of [false, true]) {
    it(`${runtime.name}: parent cancellation ${afterWinner ? "after" : "before"} winner drains race without returning a result`, async () => {
      const s = scenario();
      await s.run();
      if (afterWinner) {
        await s.choose(1, { ok: true, value: "winner" });
      }
      await s.cancel();
      s.reopen();
      await s.run();
      for (const index of [0, 1]) {
        if (s.waits.has(index)) {
          expect(s.waits.get(index)!.effect).toBe(cleanup.id);
          await s.reply(index);
        }
      }
      expect((await s.run()).state).toBe("waiting");
      expect((await s.snapshot()).history).toHaveLength(0);
      await s.finish();
      await expect(s.run()).resolves.toMatchObject({ state: "cancelled", reason: "stop parent" });
    });
  }
  it(`${runtime.name}: winner commit aborts a loser's live attempt`, async () => {
    const s = scenario(undefined, 0);
    const live = s.run();
    await s.peer.waitForRequests(1);
    await s.choose(1, { ok: true, value: "winner" });
    await expect(Promise.race([live, s.relay])).rejects.toThrow();
    const loser = await start(() => readJournal(s.children[0]!.journal));
    expect(s.notifications.published).toContain(loser.cancellation?.attempt?.attemptId);
    expect(s.peer.aborted).toContain("child-0");
    await expect(live).rejects.toThrow();
    await s.run();
    expect(s.waits.get(0)!.effect).toBe(cleanup.id);
    await s.reply(0);
    expect((await s.run()).state).toBe("waiting");
    await s.finish();
    await expect(s.run()).resolves.toEqual({
      state: "completed",
      value: { ok: true, value: "winner" },
    });
  });
  it(`${runtime.name}: relay scope disposal drops subsequent revocations without weakening fencing`, async () => {
    const s = scenario(undefined, 0);
    const active = s.run();
    await s.peer.waitForRequests(1);
    await s.stopRelay();
    await s.choose(1, { ok: true, value: "winner" });
    expect(s.revocations).toEqual([]);
    expect(s.notifications.published).toEqual([]);
    expect(s.peer.aborted).toEqual([]);
    s.peer.reply("child-0", { status: 200, body: "late body" });
    await expect(active).rejects.toThrow("revoked");
    expect((await s.snapshot()).history).toHaveLength(0);
  });
  it(`${runtime.name}: rolled-back winner revocations never reach the relay`, async () => {
    const s = scenario(undefined, 0);
    const active = s.run();
    await s.peer.waitForRequests(1);
    s.rejectRevocation(true);
    await expect(s.choose(1, { ok: true, value: "winner" })).rejects.toThrow(
      "Revocation encoding failed",
    );
    expect(s.revocations).toEqual([]);
    expect(s.notifications.published).toEqual([]);
    expect(s.peer.aborted).toEqual([]);
    expect((await s.snapshot()).history).toHaveLength(0);
    const loser = await start(() => s.children[0]!.journal.read());
    expect(loser.cancellation).toBeUndefined();
    s.rejectRevocation(false);
    await s.run(); // Retry terminal advancement, not an effect delivery.
    await expect(Promise.race([active, s.relay])).rejects.toThrow();
    expect(s.revocations).toHaveLength(1);
    expect(s.peer.aborted).toEqual(["child-0"]);
  });
  for (const dropped of [false, true]) {
    for (const physicalStop of [false, true]) {
      it(`${runtime.name}: cleanup blocks race resumption (lost relay: ${dropped}, physical stop: ${physicalStop})`, async () => {
        const s = scenario(undefined, 0, true, true);
        s.notifications.drop = dropped;
        // Register all branches first, then move branch 2 into live protected cleanup.
        s.pause(0);
        await s.run();
        await s.reply(2, { ok: true, value: "protected body" });
        s.pause();
        const active = s.run();
        await s.peer.waitForRequests(2);
        const bodyState = await start(() => s.children[0]!.journal.read());
        const protectedState = await start(() => s.children[2]!.journal.read());
        if (
          bodyState.status !== "running" ||
          !bodyState.pending ||
          protectedState.status !== "running" ||
          !protectedState.pending
        ) {
          throw new Error("Expected live body and cleanup boundaries");
        }
        const body = bodyState.pending;
        const protectedBoundary = protectedState.pending;
        expect(protectedBoundary.scope?.phase).toBe("cleanup");
        const protectedAttempt = await start(() =>
          s.children[2]!.journal.attempts.begin(protectedBoundary.id, "unsafe"),
        );
        if (protectedAttempt.state !== "occupied") {
          throw new Error("Expected live cleanup");
        }

        let winnerReturned = false;
        const choosing = s.choose(1, { ok: true, value: "winner" }).then(() => {
          winnerReturned = true;
        });
        await Promise.race([s.winnerCommitted.promise, choosing, s.relay]);
        expect(winnerReturned).toBe(false);
        expect((await s.snapshot()).history).toHaveLength(0);
        if (dropped) {
          s.peer.reply("child-0", { status: 200, body: "late body" });
        }
        await Promise.race([s.interrupted.promise, s.relay]);
        expect(winnerReturned).toBe(false);
        expect(s.revocations).toHaveLength(1);
        expect(s.revocations[0]!.execution).toBe(s.children[0]!.journal.id);
        s.releaseWinner.resolve();
        await choosing;
        expect(s.failures.map(({ index }) => index)).toEqual([0]);
        expect(s.peer.aborted).not.toContain("cleanup:child-2");
        const revoked = (await start(() => s.children[0]!.journal.read())).cancellation!.attempt!;
        expect(revoked.requestId).toBe(body.id);
        await expect(
          start(() => s.children[0]!.journal.attempts.settle(revoked, { ok: true, value: "late" })),
        ).rejects.toThrow("revoked");
        // Repeated cancellation and delayed delivery cannot revoke protected cleanup.
        await start(() =>
          s.children[2]!.journal.cancellation.request(protectedBoundary.id, "again"),
        );
        s.notifications.drop = false;
        s.notifications.publish(revoked.attemptId);
        s.notifications.publish(revoked.attemptId);
        expect(
          await start(() => s.children[2]!.journal.attemptControl.inspect(protectedAttempt.grant)),
        ).toEqual({ state: "active" });
        expect(s.peer.aborted).not.toContain("cleanup:child-2");
        if (physicalStop) {
          s.stopCleanup();
        } else {
          s.peer.reply("cleanup:child-2", { status: 200, body: "closed" });
        }
        expect(await active).toMatchObject({ state: "child", reason: "unknown" });
        expect(s.failures.map(({ index }) => index)).toEqual(physicalStop ? [0, 2] : [0]);
        s.reopen();
        expect((await s.run()).state).toBe("child");
        expect(s.waits.get(0)!.effect).toBe(cleanup.id);
        await s.reply(0);
        if (physicalStop) {
          expect(await s.run()).toMatchObject({ state: "child", reason: "occupied" });
          expect((await s.snapshot()).history).toHaveLength(0);
          const resumed = await start(() => s.children[2]!.journal.read());
          expect(resumed).toMatchObject({
            status: "running",
            pending: { id: protectedBoundary.id, scope: { phase: "cleanup" } },
          });
          expect(s.peer.requests.filter(({ id }) => id === "cleanup:child-2")).toHaveLength(1);
          // Explicit external reconciliation: confirm the original cleanup succeeded.
          // Reopen alone neither retries it nor waives its obligation.
          await start(() =>
            s.children[2]!.journal.attempts.settle(protectedAttempt.grant, {
              ok: true,
              value: { ok: true, value: "confirmed closed" },
            }),
          );
        }
        expect((await s.run()).state).toBe("waiting");
        expect((await s.snapshot()).history).toHaveLength(1);
        await s.finish();
        await expect(s.run()).resolves.toEqual({
          state: "completed",
          value: { ok: true, value: "winner" },
        });
        expect(s.peer.requests.filter(({ id }) => id === "child-0")).toHaveLength(1);
      });
    }
  }
  it(`${runtime.name}: critical loser retains authority until it can unwind, without replacing the winner`, async () => {
    const s = scenario(0);
    await s.run();
    await s.choose(1, { ok: true, value: "winner" });
    await s.reply(0, { ok: true, value: "protected late reply" });
    s.reopen();
    await s.run();
    expect(s.waits.get(0)!.effect).toBe(cleanup.id);
    await s.reply(0);
    expect((await s.run()).state).toBe("waiting");
    await s.finish();
    await expect(s.run()).resolves.toEqual({
      state: "completed",
      value: { ok: true, value: "winner" },
    });
  });
  it(`${runtime.name}: race queues stop for a loser that has never started`, async () => {
    const s = scenario();
    s.pause(0);
    await s.run();
    await s.choose(1, { ok: true, value: "winner" });
    expect(s.visits[0]).toBe(0);
    s.reopen();
    await s.run();
    expect(s.waits.get(0)!.effect).toBe(cleanup.id);
    await s.reply(0);
    await s.run();
    await s.finish();
    await expect(s.run()).resolves.toMatchObject({
      state: "completed",
      value: { ok: true, value: "winner" },
    });
  });
  it(`${runtime.name}: loser cleanup failure is retained instead of silently returning the winner`, async () => {
    const s = scenario();
    await s.run();
    await s.choose(1, { ok: true, value: "winner" });
    await s.run();
    await s.reply(0, { ok: true, value: "unused" }, "Loser cleanup failed");
    expect((await s.run()).state).toBe("waiting");
    expect((await s.snapshot()).history).toHaveLength(0);
    await s.finish();
    await expect(s.run()).resolves.toMatchObject({
      state: "cancelled",
      reason: "Race loser cleanup failed",
      failure: "Loser cleanup failed",
    });
  });
});
