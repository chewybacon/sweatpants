import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import type { Operation, Work } from "@standard-durability/core";
import {
  defineEffect,
  type All,
  type Race,
  type Branch,
  type CapabilityRequest,
} from "@sweatpan.ts/core";
import { createRecovery, type OwnedJournal, type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createScopedGuest,
  type LogicalScope,
  type ScopeInstruction,
} from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  createOwnedAll,
  createOwnedRace,
  installGuestRetention,
  type HostedResult,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";
import { createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
import { forEachRuntime } from "../runtime/assembly.ts";

const fetchSource = defineEffect({
  key: "research.source",
  context: z.string(),
  response: z.string(),
});
const release = defineEffect({
  key: "research.release",
  context: z.string(),
  response: z.string(),
});
type Instructions = CapabilityRequest | ScopeInstruction;
interface Context {
  readonly scope: LogicalScope;
  readonly all: All<Context, Instructions>;
  readonly race: Race<Context, Instructions>;
  readonly fetchSource: typeof fetchSource.call;
  readonly release: typeof release.call;
}
type Finding = { source: string; text: string };
type Factory = Branch<Context, Instructions>;

// Authored application: each factory uses its own supplied scope and capabilities.
function* source(ctx: Context, name: string): Operation<Finding, Instructions> {
  yield* ctx.scope.ensure(function* () {
    yield* ctx.release(name);
  });
  const reply = yield* ctx.fetchSource(name);
  if (!reply.ok) {
    throw new Error("Source declined");
  }
  return { source: name, text: reply.value };
}
function* researcher(ctx: Context, topic: string) {
  yield* ctx.scope.ensure(function* () {
    yield* ctx.release(topic);
  });
  return yield* ctx.race(
    function* (branch) {
      return yield* source(branch, `${topic}/primary`);
    },
    function* (branch) {
      return yield* source(branch, `${topic}/backup`);
    },
  );
}
const research: Factory = function* (ctx) {
  yield* ctx.scope.ensure(function* () {
    yield* ctx.release("report");
  });
  const results = yield* ctx.all(
    function* (branch) {
      return yield* researcher(branch, "security");
    },
    function* (branch) {
      return yield* researcher(branch, "performance");
    },
  );
  expectTypeOf(results).toEqualTypeOf<[Finding, Finding]>();
  return results;
};

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  for (const retained of [false, true]) {
    for (const cancelled of [false, true]) {
      it(`${runtime.name}: researchers compose all and race across reopen (retained ${retained}, cancelled ${cancelled})`, async () => {
        type Journal = OwnedJournal<unknown, CapabilityRequest, unknown, string, unknown, Y>;
        const store = createSqliteJournalRig<
          unknown,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({ program: "research:v1", equals: isDeepStrictEqual });
        onTestFinished(() => store.close());
        let root = store.open();
        const waits = new Map<
          string,
          { journal: Journal; grant: ResolutionGrant; effect: string }
        >();
        const journals = new Map<string, Journal>();
        const acquisitions = new Map<string, number>();
        const paused = new Set<string>();
        function run() {
          waits.clear();
          return start(function* () {
            // One assembly of each kind is shared at every depth.
            const all = createOwnedAll<Context, Instructions, Y>(runtime, "research.all");
            const race = createOwnedRace<Context, Instructions, Y>(runtime, "research.race");
            const effects = createEffectCapabilities(runtime, "research-effects");
            function* drive(
              journal: Journal,
              program: string,
              factory: Factory,
              path: string,
            ): Operation<HostedResult<unknown, CapabilityRequest>, Y> {
              journals.set(path, journal);
              const grant = effects.grant({
                all: all.effect,
                race: race.effect,
                fetchSource,
                release,
              });
              const recovery = createRecovery<unknown, CapabilityRequest, Y, unknown, string>(
                runtime.composition,
                {
                  name: `recovery:${journal.id}`,
                  program,
                  matches: isDeepStrictEqual,
                  *acquire() {
                    acquisitions.set(path, (acquisitions.get(path) ?? 0) + 1);
                    const callAll = yield* all.acquire();
                    const callRace = yield* race.acquire();
                    return createScopedGuest((scope) =>
                      factory({
                        scope,
                        all: callAll,
                        race: callRace,
                        fetchSource: grant.capabilities.fetchSource,
                        release: grant.capabilities.release,
                      }),
                    );
                  },
                },
              );
              const host = createHosting(runtime.composition, {
                name: `host:${journal.id}`,
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
              for (const group of [all, race]) {
                yield* group.install({
                  host,
                  journal,
                  recovery,
                  *run(child, branch, index) {
                    const childPath = `${path}/${index}`;
                    if (paused.has(childPath)) {
                      return false;
                    }
                    const result = yield* drive(
                      child.journal,
                      child.link.program,
                      branch,
                      childPath,
                    );
                    return result.state === "completed" || result.state === "cancelled";
                  },
                });
              }
              if (retained) {
                yield* installGuestRetention(runtime.composition, host, recovery, journal);
              }
              const result = yield* host.operations.run();
              if (result.state === "waiting") {
                waits.set(result.pending.request.input as string, {
                  journal,
                  grant: result.grant,
                  effect: result.pending.request.effect,
                });
              }
              return result;
            }
            return yield* drive(root, "research:v1", research, "root");
          });
        }
        async function reply(name: string, value = "released") {
          const wait = waits.get(name)!;
          await start(() =>
            wait.journal.interactions.answer(wait.grant, { ok: true, value: { ok: true, value } }),
          );
        }
        async function choose(topic: string, index: number, parent: number) {
          const name = `${topic}/${index === 0 ? "primary" : "backup"}`;
          await reply(name, `${topic} finding`);
          await run();
          expect(waits.get(name)!.effect).toBe(release.id);
          await reply(name);
          // Control terminal-commit order; automatic stale-host retry is not claimed.
          paused.add(`root/${parent}/${1 - index}`);
          await run();
          paused.clear();
        }
        expect((await run()).state).toBe("child");
        expect([...waits.keys()].sort()).toEqual([
          "performance/backup",
          "performance/primary",
          "security/backup",
          "security/primary",
        ]);
        const stale = waits.get("security/backup")!;
        const performanceWaits = [
          waits.get("performance/primary")!,
          waits.get("performance/backup")!,
        ];
        const originalIds = new Map([...journals].map(([path, journal]) => [path, journal.id]));
        await choose("security", 0, 0);
        await expect(
          start(() =>
            stale.journal.interactions.answer(stale.grant, {
              ok: true,
              value: { ok: true, value: "too late" },
            }),
          ),
        ).rejects.toThrow("revoked");
        const winnerVisits = acquisitions.get("root/0/0");
        if (cancelled) {
          const snapshot = await start(() => root.read());
          if (snapshot.status !== "running" || !snapshot.pending) {
            throw new Error("Expected owned group");
          }
          await start(() => root.cancellation.request(snapshot.pending!.id, "stop research"));
          for (const wait of performanceWaits) {
            await expect(
              start(() =>
                wait.journal.interactions.answer(wait.grant, {
                  ok: true,
                  value: { ok: true, value: "late after cancellation" },
                }),
              ),
            ).rejects.toThrow("revoked");
          }
        }
        root = store.reopen();
        await run();
        expect(acquisitions.get("root/0/0")).toBe(winnerVisits);
        expect(new Map([...journals].map(([path, journal]) => [path, journal.id]))).toEqual(
          originalIds,
        );
        expect(waits.get("security/backup")!.effect).toBe(release.id);
        if (!cancelled) {
          await choose("performance", 1, 1);
          await run();
        }
        // Every unfinished source must drain before its owning researcher can clean up.
        expect(waits.has("security")).toBe(false);
        expect(waits.has("performance")).toBe(false);
        expect(waits.has("report")).toBe(false);
        for (const [name, wait] of waits) {
          expect(wait.effect).toBe(release.id);
          await reply(name);
        }
        expect((await run()).state).toBe("child");
        expect([...waits.keys()].sort()).toEqual(["performance", "security"]);
        expect((await start(() => readJournal(root))).history).toHaveLength(0);
        // Complete the second researcher first: all still returns declaration order.
        await reply("performance");
        await run();
        expect(waits.has("report")).toBe(false);
        await reply("security");
        expect((await run()).state).toBe("waiting");
        expect([...waits.keys()]).toEqual(["report"]);
        await reply("report");
        const expected = cancelled
          ? { state: "cancelled", reason: "stop research" }
          : {
              state: "completed",
              value: [
                { source: "security/primary", text: "security finding" },
                { source: "performance/backup", text: "performance finding" },
              ],
            };
        await expect(run()).resolves.toMatchObject(expected);
        expect((await start(() => readJournal(root))).history).toHaveLength(cancelled ? 1 : 2);
        root = store.reopen();
        const finalVisits = new Map(acquisitions);
        await expect(run()).resolves.toMatchObject(expected);
        expect(acquisitions).toEqual(finalVisits);
      });
    }
  }
});
