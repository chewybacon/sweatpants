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
import { createRecovery, type OwnedChild, type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createEffectCapabilities,
  createHosting,
  createOwnedRace,
  installGuestRetention,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
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
  function scenario(protectedIndex?: number) {
    const store = createSqliteJournalRig<Result, CapabilityRequest, unknown, string, unknown, Y>({
      program: "race-parent:v1",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    let journal = store.open();
    type Child = OwnedChild<unknown, CapabilityRequest, unknown, string, unknown, Y>;
    let children: Child[] = [];
    const waits = new Map<number, { grant: ResolutionGrant; effect: string }>();
    const visits = [0, 0];
    let parentWait: ResolutionGrant | undefined;
    let boundary = "";
    let paused: number | undefined;
    function run() {
      return start(function* () {
        const effects = createEffectCapabilities(runtime, "race-effects");
        const owned = createOwnedRace<Context, CapabilityRequest | ScopeInstruction, Y>(
          runtime,
          "race.group",
        );
        const grant = effects.grant({ race: owned.effect, cleanup });
        const recovery = createRecovery<Result, CapabilityRequest, Y, unknown, string>(
          runtime.composition,
          {
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
                const result = yield* race(branch(0), branch(1));
                expectTypeOf(result).toEqualTypeOf<Result>();
                return result;
              });
            },
          },
        );
        function* drive(child: Child, factory: Factory, index: number): Operation<boolean, Y> {
          children[index] = child;
          boundary = child.link.requestId;
          if (paused === index) {
            return false;
          }
          const childGrant = effects.grant({ answer, cleanup });
          const childRecovery = createRecovery(runtime.composition, {
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
            journal: child.journal,
            recovery: childRecovery.operations,
            attempts: child.journal.attempts,
            interactions: child.journal.interactions,
            handle: childGrant.handle,
          });
          yield* host.around(childGrant.admission);
          yield* host.around({
            *deliveryMode() {
              return "wait";
            },
          });
          const result = yield* host.operations.run();
          if (result.state === "waiting") {
            waits.set(index, { grant: result.grant, effect: result.pending.request.effect });
          } else {
            waits.delete(index);
          }
          return result.state === "completed" || result.state === "cancelled";
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
        yield* owned.install({ host, journal, recovery, run: drive });
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
