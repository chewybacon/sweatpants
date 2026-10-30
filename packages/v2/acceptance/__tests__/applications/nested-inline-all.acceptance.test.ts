import {
  createHostedRecovery as createRecovery,
  createSqliteJournalRig,
  readJournal,
} from "@sweatpan.ts/testing";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { expect, it, onTestFinished } from "vitest";
import type { Operation, Work } from "@standard-durability/core";
import { defineEffect, type All, type Branch, type CapabilityRequest } from "@sweatpan.ts/core";
import { type OwnedJournal, type ResolutionGrant } from "@sweatpan.ts/durable";
import {
  createScopedGuest,
  type LogicalScope,
  type ScopeInstruction,
} from "@sweatpan.ts/execution";
import {
  createEffectCapabilities,
  createHosting,
  createOwnedAll,
  installGuestRetention,
  type HostedResult,
} from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

import { forEachRuntime } from "../runtime/assembly.ts";

const question = defineEffect({
  key: "nested.question",
  context: z.string(),
  response: z.boolean(),
});
interface Context {
  readonly depth: number;
  readonly scope: LogicalScope;
  readonly all: All<Context, CapabilityRequest | ScopeInstruction>;
  readonly ask: typeof question.call;
}
type Factory = Branch<Context, CapabilityRequest | ScopeInstruction>;

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const execution = runtime.start(work);
    void execution.result.catch(() => undefined);
    onTestFinished(() => execution.cancel());
    return execution.result;
  }
  for (const innerCount of [2, 3]) {
    for (const retainInner of [false, true]) {
      it(`${runtime.name}: nested all isolates same-slot factories (inner count ${innerCount}, retained ${retainInner}) across reopen`, async () => {
        type Journal = OwnedJournal<unknown, CapabilityRequest, unknown, string, unknown, Y>;
        const store = createSqliteJournalRig<
          unknown,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({
          program: "nested-parent:v1",
          equals: isDeepStrictEqual,
        });
        onTestFinished(() => store.close());
        let root = store.open();
        const waits = new Map<string, { journal: Journal; grant: ResolutionGrant }>();
        const identities = new Map<string, string>();
        const acquisitions = new Map<string, number>();
        let completedOuter: Journal | undefined;
        const rootFactory: Factory = function* (ctx) {
          if (ctx.depth !== 0) {
            throw new Error("Root factory used by another execution");
          }
          return yield* ctx.all(
            function* (branch) {
              if (branch.depth !== 1) {
                throw new Error("Ancestor factory used by inner execution");
              }
              return yield* branch.all(
                ...Array.from(
                  { length: innerCount },
                  (_, index): Factory =>
                    function* (leaf) {
                      if (leaf.depth !== 2) {
                        throw new Error("Leaf factory used by another execution");
                      }
                      const reply = yield* leaf.ask(`leaf-${index}`);
                      return `${index}:${reply.ok && reply.value}`;
                    },
                ),
              );
            },
            function* (branch) {
              if (branch.depth !== 1) {
                throw new Error("Ancestor factory used by inner execution");
              }
              return "outer-right";
            },
          );
        };
        function run() {
          return start(function* () {
            // Deliberately reuse ONE assembly at every depth. Its context inherits.
            const owned = createOwnedAll<Context, CapabilityRequest | ScopeInstruction, Y>(
              runtime,
              "nested.all",
            );
            const effects = createEffectCapabilities(runtime, "nested-effects");
            function* drive(
              journal: Journal,
              program: string,
              factory: Factory,
              depth: number,
            ): Operation<HostedResult<unknown, CapabilityRequest>, Y> {
              const grant = effects.grant({ question, all: owned.effect });
              const recovery = createRecovery<unknown, CapabilityRequest, Y, unknown, string>(
                runtime,
                {
                  name: `recover:${journal.id}`,
                  program,
                  matches: isDeepStrictEqual,
                  *acquire() {
                    acquisitions.set(journal.id, (acquisitions.get(journal.id) ?? 0) + 1);
                    const all = yield* owned.acquire();
                    return createScopedGuest((scope) =>
                      factory({ depth, scope, all, ask: grant.capabilities.question }),
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
              yield* owned.install({
                host,
                journal,
                recovery,
                *run(child, branch, index) {
                  if (depth === 0 && index === 1) {
                    completedOuter = child.journal;
                  }
                  const result = yield* drive(child.journal, child.link.program, branch, depth + 1);
                  return result.state === "completed" || result.state === "cancelled";
                },
              });
              // Root retention leaves an ancestor registry visible. Inner ordinary
              // activation disposes its registry before routing; reopen also skips it.
              if (depth === 0 || retainInner) {
                yield* installGuestRetention(runtime.composition, host, recovery, journal);
              }
              const result = yield* host.operations.run();
              if (result.state === "waiting") {
                const label = result.pending.request.input as string;
                waits.set(label, { journal, grant: result.grant });
                identities.set(label, journal.id);
              }
              return result;
            }
            return yield* drive(root, "nested-parent:v1", rootFactory, 0);
          });
        }
        async function answer(label: string) {
          const waiting = waits.get(label)!;
          await start(() =>
            waiting.journal.interactions.answer(waiting.grant, {
              ok: true,
              value: { ok: true, value: true },
            }),
          );
        }
        expect((await run()).state).toBe("child");
        expect([...waits.keys()].sort()).toEqual(
          Array.from({ length: innerCount }, (_, index) => `leaf-${index}`),
        );
        const originalIds = new Map(identities);
        const outerId = completedOuter!.id;
        const outerVisits = acquisitions.get(outerId);
        expect((await start(() => completedOuter!.read())).status).toBe("completed");
        await answer("leaf-0");
        expect((await run()).state).toBe("child");
        const firstId = identities.get("leaf-0")!;
        const firstVisits = acquisitions.get(firstId);
        root = store.reopen();
        waits.clear();
        expect((await run()).state).toBe("child");
        expect(waits.has("leaf-0")).toBe(false);
        expect(identities).toEqual(originalIds);
        expect(acquisitions.get(firstId)).toBe(firstVisits);
        expect(acquisitions.get(outerId)).toBe(outerVisits);
        for (let index = 1; index < innerCount; index++) {
          await answer(`leaf-${index}`);
        }
        const expected = {
          state: "completed",
          value: [Array.from({ length: innerCount }, (_, index) => `${index}:true`), "outer-right"],
        };
        await expect(run()).resolves.toEqual(expected);
        const snapshot = await start(() => readJournal(root));
        expect(snapshot.history).toHaveLength(1);
        expect(snapshot.history[0]!.outcome).toEqual({
          ok: true,
          value: { ok: true, value: expected.value },
        });
        root = store.reopen();
        const finalVisits = new Map(acquisitions);
        await expect(run()).resolves.toEqual(expected);
        expect(acquisitions).toEqual(finalVisits);
      });
    }
  }
});
