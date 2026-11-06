import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, expectTypeOf, it, onTestFinished } from "vitest";
import { z } from "zod";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createKernel,
  createExecution,
  createScopedKernel,
  createProgramExecution,
  type Kernel,
  type PreparedProgram,
  type Operation,
} from "@sweatpan.ts/execution";
import {
  createLuaKernel,
  defineLuaEffectBindings,
  luaWasmUrl,
} from "@sweatpan.ts/codemode-runtime-lua";
import { createRecovery } from "@sweatpan.ts/durable";
import { createEffectCapabilities, createHosting } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

let compiled: Promise<WebAssembly.Module> | undefined;
const loadModule = () =>
  (compiled ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)));
const lookup = defineEffect({ key: "kernel.lookup", context: z.string(), response: z.string() });
const bindings = defineLuaEffectBindings({ lookup });
const luaSource = `
local input = ...
local first = workflow.effect("first", { effect = "lookup", input = input })
assert(first.ok)
local second = workflow.effect("second", { effect = "lookup", input = first.value })
assert(second.ok)
return second.value
`;
function* body(input: string): Operation<string, CapabilityRequest> {
  const first = yield* lookup.call(input);
  if (!first.ok) {
    throw new Error("lookup failed");
  }
  const second = yield* lookup.call(first.value);
  if (!second.ok) {
    throw new Error("lookup failed");
  }
  return second.value;
}

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const language of ["lua", "typescript"] as const) {
    it(`${runtime.name} ${language}: one kernel consumer recovers accepted work through existing hosting`, async () => {
      async function exercise<P>(
        driver: Kernel<P, string, PreparedProgram<string, CapabilityRequest, Y>, Y>,
        program: P,
      ) {
        const store = createSqliteJournalRig<
          string,
          CapabilityRequest,
          unknown,
          string,
          unknown,
          Y
        >({ program: "kernel-fixture", equals: isDeepStrictEqual });
        onTestFinished(() => store.close());
        const deliveries: string[] = [];
        let prepared = 0;
        let acquired = 0;
        let starts = 0;
        const kernel = createKernel(runtime.composition, "fixture-kernel", driver);
        function run(interrupt = false) {
          const task = runtime.start(function* () {
            yield* kernel.around({
              *prepare(args, next) {
                prepared++;
                const recipe = yield* next(...args);
                return {
                  ...recipe,
                  *acquire() {
                    acquired++;
                    // Preserve identity so the recipe's checkpoint adapter still
                    // recognizes the acquired Guest.
                    return yield* recipe.acquire();
                  },
                };
              },
            });
            const execution = createProgramExecution({
              invocation: { program: "kernel-fixture", input: "topic" },
              *resolve(invocation) {
                // Fixture inventory verifies this ID; the kernel does not grant it identity.
                if (invocation.program !== "kernel-fixture") {
                  throw new Error("Unknown program");
                }
                const recipe = yield* kernel.operations.prepare(program, invocation.input);
                return { ...recipe, program: "kernel-fixture" };
              },
            });
            const journal = store.open();
            const recovery = createRecovery(runtime.composition, {
              name: "kernel-recovery",
              program: "kernel-fixture",
              matches: isDeepStrictEqual,
              acquire: execution.acquire,
            });
            yield* recovery.execution.around({
              *start(args, next) {
                starts++;
                return yield* next(...args);
              },
            });
            const effects = createEffectCapabilities(runtime, "kernel-effects");
            const grant = effects.grant({ lookup });
            yield* effects.install(lookup, function* (input) {
              deliveries.push(input);
              return { ok: true, value: `${input}!` };
            });
            const host = createHosting(runtime.composition, {
              name: "kernel-host",
              journal,
              recovery: recovery.operations,
              handle: grant.handle,
              attempts: {
                begin: journal.attempts.begin,
                *settle(...args: Parameters<typeof journal.attempts.settle>) {
                  const receipt = yield* journal.attempts.settle(...args);
                  if (interrupt) {
                    throw new Error("Stopped after acceptance");
                  }
                  return receipt;
                },
              },
            });
            yield* host.around(grant.admission);
            return yield* host.operations.run();
          });
          onTestFinished(() => task.cancel());
          return task.result;
        }
        await expect(run(true)).rejects.toThrow("Stopped after acceptance");
        expect(deliveries).toEqual(["topic"]);
        expect(starts).toBe(acquired);
        store.reopen();
        expect(await run()).toEqual({ state: "completed", value: "topic!!" });
        expect(deliveries).toEqual(["topic", "topic!"]);
        expect(prepared).toBe(acquired);
        expect(acquired).toBeGreaterThanOrEqual(2);
        expect(starts).toBe(acquired);
        const before = prepared;
        expect(await run()).toEqual({ state: "completed", value: "topic!!" });
        expect(prepared).toBe(before);
        // Preparation middleware belongs to the earlier scopes, not to the kernel instance.
        const fresh = runtime.start(() => kernel.operations.prepare(program, "other"));
        onTestFinished(() => fresh.cancel());
        await fresh.result;
        expect(prepared).toBe(before);
      }
      if (language === "lua") {
        await exercise(
          createLuaKernel(runtime, {
            loadModule,
            decodeRequest: (value) => bindings.decodeRequest(value),
            decodeResult: (value) => z.string().parse(value),
          }),
          luaSource,
        );
      } else {
        await exercise(createScopedKernel<string, string, CapabilityRequest>(), body);
      }
    });
  }

  it(`${runtime.name}: Lua recipes are lazy, independent, and restore without a new execution abstraction`, async () => {
    let loads = 0;
    const kernel = createKernel(
      runtime.composition,
      "lua-kernel",
      createLuaKernel(runtime, {
        loadModule() {
          loads++;
          return loadModule();
        },
        decodeRequest: (value) => bindings.decodeRequest(value),
        decodeResult: (value) => z.string().parse(value),
      }),
    );
    const task = runtime.start(function* () {
      const recipe = yield* kernel.operations.prepare(luaSource, "topic");
      expectTypeOf(recipe.checkpoints.format).toEqualTypeOf<string>();
      const a = yield* recipe.acquire();
      const b = yield* recipe.acquire();
      const execution = createExecution<string, CapabilityRequest, Y>(
        runtime.composition,
        "checkpoint-execution",
      );
      const calls: string[] = [];
      yield* execution.around({
        *start(args, next) {
          calls.push("start");
          return yield* next(...args);
        },
        *resume(args, next) {
          calls.push("resume");
          return yield* next(...args);
        },
      });
      yield* execution.install(a);
      yield* runtime.composition.ensure(() => b.close());
      expect(a).not.toBe(b);
      expect(loads).toBe(0);
      const first = yield* execution.operations.start();
      expect(first).toMatchObject({ kind: "suspended", request: { input: "topic" } });
      const snapshot = yield* recipe.checkpoints.capture(a);
      expect(snapshot).toBeDefined();
      yield* execution.operations.close();
      const fresh = yield* kernel.operations.prepare(luaSource, "topic");
      expect(yield* fresh.checkpoints.capture(b)).toBeUndefined();
      yield* runtime.composition.scoped(function* () {
        const restored = yield* fresh.checkpoints.restore(snapshot);
        yield* execution.install(restored.guest);
        expect(restored.turn).toEqual(first);
        expect(
          yield* execution.operations.resume({ ok: true, value: { ok: true, value: "accepted" } }),
        ).toMatchObject({
          kind: "suspended",
          request: { input: "accepted" },
        });
        // The same method middleware applies after restore, without replacing
        // the Guest identity used by capture.
        expect(yield* fresh.checkpoints.capture(restored.guest)).toBeDefined();
        expect(
          yield* execution.operations.resume({ ok: true, value: { ok: true, value: "done" } }),
        ).toEqual({ kind: "completed", value: "done" });
      });
      expect(calls).toEqual(["start", "resume", "resume"]);
      const changed = yield* kernel.operations.prepare("return 'changed'", "topic");
      let mismatch: unknown;
      try {
        yield* changed.checkpoints.restore(snapshot);
      } catch (error) {
        mismatch = error;
      }
      expect(String(mismatch)).toContain("source/runtime mismatch");
      expect(yield* b.start()).toMatchObject({ kind: "suspended", request: { input: "topic" } });
      const ts = yield* createScopedKernel<string, string, CapabilityRequest>().prepare(
        body,
        "topic",
      );
      // @ts-expect-error Replay-only kernels do not advertise checkpoint support.
      expect(ts.checkpoints).toBeUndefined();
      expect("checkpoints" in ts).toBe(false);
    });
    onTestFinished(() => task.cancel());
    await task.result;
  });
});
