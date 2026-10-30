import {
  createHostedExecution,
  createHostedRecovery as createRecovery,
  createSqliteJournalRig,
} from "@sweatpan.ts/testing";
import {
  createRecovery as createPlacedRecovery,
  createCheckpointMiddleware,
  type OwnedChild,
  type ResolutionGrant,
} from "@sweatpan.ts/durable";

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { Work, Operation } from "@standard-durability/core";
import { createScopedGuest } from "@sweatpan.ts/execution";

import { createHosting } from "@sweatpan.ts/hosting";
import { createLuaEvaluator, luaWasmUrl } from "@sweatpan.ts/codemode-runtime-lua";
import type { Runtime } from "@sweatpan.ts/runtime";

import { forEachRuntime } from "../runtime/assembly.ts";

let module: Promise<WebAssembly.Module> | undefined;
const loadModule = () =>
  (module ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)));
const source = `
return workflow.scope(function()
  return workflow.effect("body", "work")
end, function(completion)
  workflow.effect("cleanup", "cleanup")
end)
`;
function request(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("request" in value) ||
    typeof value.request !== "string"
  ) {
    throw new Error("Expected Lua request");
  }
  return value.request;
}
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  function start<T>(work: Work<T, Y>) {
    const task = runtime.start(work);
    void task.result.catch(() => undefined);
    onTestFinished(() => task.cancel());
    return task.result;
  }
  function evaluator(code = source) {
    return createLuaEvaluator(runtime, {
      source: code,
      input: null,
      loadModule,
      decodeRequest: request,
      decodeResult: (value) => String(value),
    });
  }
  it(`${runtime.name}: Lua cancellation cannot become successful by catching its signal`, async () => {
    await start(function* () {
      const lua = evaluator(
        'pcall(function() workflow.effect("body", "work") end); return "caught"',
      );
      const guest = yield* lua.acquire();
      yield* runtime.composition.ensure(() => guest.close());
      yield* guest.start();
      expect(yield* guest.cancel!("stop")).toEqual({ kind: "cancelled", reason: "stop" });
    });
  });
  it(`${runtime.name}: Lua cannot deliver a new body exchange after catching cancellation`, async () => {
    await expect(
      start(function* () {
        const lua = evaluator(
          'pcall(function() workflow.effect("body", "work") end); return workflow.effect("escaped", "escaped")',
        );
        const guest = yield* lua.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        yield* guest.start();
        return yield* guest.cancel!("stop");
      }),
    ).rejects.toThrow("Lua yielded outside cleanup during cancellation");
  });
  for (const duringCleanup of [false, true]) {
    for (const failure of [false, true]) {
      it(`${runtime.name}: Lua cancellation preserves cleanup and checkpoint restore (already cleaning ${duringCleanup}, failure ${failure})`, async () => {
        await start(function* () {
          const lua = evaluator();
          const guest = yield* lua.acquire();
          yield* runtime.composition.ensure(() => guest.close());
          const body = yield* guest.start();
          expect(body).toMatchObject({
            kind: "suspended",
            request: "work",
            scope: { phase: "body" },
          });
          let cleanup;
          if (duringCleanup) {
            cleanup = yield* guest.resume({ ok: true, value: "body-result" });
          }
          const cancelled = yield* guest.cancel!("stop lua");
          expect(cancelled).toMatchObject({
            kind: "suspended",
            request: "cleanup",
            scope: { phase: "cleanup" },
          });
          if (cleanup) {
            expect(cancelled).toEqual(cleanup);
          }
          expect(yield* guest.cancel!("second reason")).toEqual(cancelled);
          const checkpoint = yield* lua.checkpoints.capture(guest);
          yield* guest.close(); // Disposal does not answer or unwind cleanup.
          const restored = yield* lua.checkpoints.restore(checkpoint);
          yield* runtime.composition.ensure(() => restored.guest.close());
          expect(restored.turn).toEqual(cancelled);
          expect(yield* restored.guest.cancel!("third reason")).toEqual(cancelled);
          const terminal = yield* restored.guest.resume(
            failure ? { ok: false, error: "cleanup failed" } : { ok: true, value: "closed" },
          );
          expect(terminal).toEqual({
            kind: "cancelled",
            reason: "stop lua",
            failure: failure ? "cleanup failed" : undefined,
          });
          expect(yield* restored.guest.cancel!("fourth reason")).toEqual(terminal);
        });
      });
    }
    it(`${runtime.name}: losing Lua child drains ${duringCleanup ? "protected" : "new"} cleanup across journal reopen`, async () => {
      type Child = OwnedChild<string, string, string, string, unknown, Y>;
      const store = createSqliteJournalRig<string, string, string, string, unknown, Y>({
        program: "lua-race:v1",
        equals: isDeepStrictEqual,
      });
      onTestFinished(() => store.close());
      let journal = store.open();
      const children: Child[] = [];
      const waits = new Map<number, { grant: ResolutionGrant; request: string }>();
      let parentWait: ResolutionGrant | undefined;
      let restored = 0;
      function run() {
        waits.clear();
        return start(function* () {
          const recovery = createRecovery(runtime, {
            name: "lua-race-parent",
            program: "lua-race:v1",
            matches: isDeepStrictEqual,
            *acquire() {
              return createScopedGuest(function* (scope) {
                yield* scope.ensure(function* () {
                  yield "parent-cleanup";
                });
                return (yield "race") as string;
              });
            },
          });
          const host = createHosting(runtime.composition, {
            name: "lua-race-host",
            journal,
            recovery: recovery.operations,
            attempts: journal.attempts,
            interactions: journal.interactions,
            *handle(): Operation<never, Y> {
              throw new Error("Participant delivery only");
            },
          });
          yield* host.around({
            *deliveryMode() {
              return "wait";
            },
            *child([pending], next) {
              if (pending.request !== "race") {
                return yield* next(pending);
              }
              const group = yield* journal.ensureChildren<string, string, string, string>(
                pending.id,
                {
                  join: "race",
                  children: [
                    { program: "lua-child:v1", input: null },
                    { program: "winner:v1", input: null },
                  ],
                  outcome: (values) => ({ ok: true, value: values[0]! }),
                },
              );
              return {
                id: pending.id,
                *run() {
                  const results = yield* runtime.all(
                    group.map(
                      (child, index) =>
                        function* () {
                          children[index] = child;
                          const lua = evaluator();
                          const placement = createHostedExecution<
                            string,
                            string,
                            Y,
                            string,
                            string
                          >(runtime, {
                            acquire:
                              index === 0
                                ? lua.acquire
                                : function* () {
                                    return createScopedGuest(function* () {
                                      return (yield "win") as string;
                                    });
                                  },
                            checkpoints: lua.checkpoints,
                          });
                          const checkpointAdapter = placement.checkpoints;
                          if (!checkpointAdapter) {
                            throw new Error("Expected checkpoint capability");
                          }
                          const childRecovery = createPlacedRecovery<
                            string,
                            string,
                            Y,
                            string,
                            string
                          >(runtime.composition, {
                            name: `child:${index}`,
                            program: child.link.program,
                            matches: isDeepStrictEqual,
                            acquire: placement.acquire,
                          });
                          if (index === 0) {
                            yield* childRecovery.around(
                              createCheckpointMiddleware({
                                program: child.link.program,
                                execution: childRecovery.execution,
                                matches: isDeepStrictEqual,
                                adapter: {
                                  ...checkpointAdapter,
                                  *restore(saved) {
                                    restored++;
                                    return yield* checkpointAdapter.restore(saved);
                                  },
                                },
                              }),
                            );
                          }
                          const childHost = createHosting(runtime.composition, {
                            name: `child-host:${index}`,
                            journal: child.journal,
                            recovery: childRecovery.operations,
                            attempts: child.journal.attempts,
                            interactions: child.journal.interactions,
                            *handle(): Operation<never, Y> {
                              throw new Error("Participant delivery only");
                            },
                          });
                          yield* childHost.around({
                            *deliveryMode() {
                              return "wait";
                            },
                          });
                          const result = yield* childHost.operations.run();
                          if (result.state === "waiting") {
                            waits.set(index, {
                              grant: result.grant,
                              request: result.pending.request,
                            });
                          }
                          return result.state === "completed" || result.state === "cancelled";
                        },
                    ),
                  );
                  return results.every(Boolean);
                },
              };
            },
          });
          const result = yield* host.operations.run();
          if (result.state === "waiting") {
            parentWait = result.grant;
          }
          return result;
        });
      }
      async function answer(index: number, value: string) {
        await start(() =>
          children[index]!.journal.interactions.answer(waits.get(index)!.grant, {
            ok: true,
            value,
          }),
        );
      }
      expect((await run()).state).toBe("child");
      if (duringCleanup) {
        await answer(0, "lua-result");
        await run();
      }
      const loserGrant = waits.get(0)!.grant;
      journal = store.reopen();
      await run();
      expect(restored).toBeGreaterThan(0);
      await answer(1, "winner");
      expect((await run()).state).toBe("child");
      if (!duringCleanup) {
        await expect(
          start(() =>
            children[0]!.journal.interactions.answer(loserGrant, { ok: true, value: "late" }),
          ),
        ).rejects.toThrow("revoked");
      }
      journal = store.reopen();
      await run();
      expect(waits.get(0)!.request).toBe("cleanup");
      if (duringCleanup) {
        expect(waits.get(0)!.grant).toEqual(loserGrant);
      }
      await answer(0, "closed");
      expect((await run()).state).toBe("waiting");
      expect((await start(() => children[0]!.journal.read())).status).toBe("cancelled");
      await start(() =>
        journal.interactions.answer(parentWait!, { ok: true, value: "parent closed" }),
      );
      await expect(run()).resolves.toEqual({ state: "completed", value: "winner" });
    });
  }
});
