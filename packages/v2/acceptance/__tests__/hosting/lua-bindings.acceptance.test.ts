import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import {
  createLuaEvaluator,
  defineLuaEffectBindings,
  luaWasmUrl,
} from "@sweatpan.ts/codemode-runtime-lua";
import { createRecovery } from "@sweatpan.ts/durable";
import { createEffectCapabilities, createHosting } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig, readJournal } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

let compiled: Promise<WebAssembly.Module> | undefined;
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  for (const scenario of [
    "unknown",
    "ungranted",
    "malformed",
    "invalid-input",
    "invalid-response",
  ] as const) {
    it(`${runtime.name}: Lua binding rejects ${scenario} without accepted history`, async () => {
      const store = createSqliteJournalRig<unknown, CapabilityRequest, unknown, string, unknown, Y>(
        {
          program: "lua-bindings",
          equals: isDeepStrictEqual,
        },
      );
      onTestFinished(() => store.close());
      let parses = 0;
      let calls = 0;
      const schema: StandardSchemaV1<string, string> = {
        "~standard": {
          version: 1,
          vendor: "lua-bindings",
          validate(value) {
            parses++;
            return typeof value === "string"
              ? { value }
              : { issues: [{ message: "Expected text" }] };
          },
        },
      };
      const effect = defineEffect({ key: "service:lookup", context: schema, response: schema });
      const definitions = { lookup: effect };
      const bindings = defineLuaEffectBindings(definitions);
      // Later assembly mutations must not silently retarget a pinned Lua program.
      definitions.lookup = defineEffect({ key: "replacement", context: schema, response: schema });
      const payload =
        scenario === "malformed"
          ? '"bad"'
          : `{ effect = "${scenario === "unknown" ? "toString" : "lookup"}", input = ${scenario === "invalid-input" ? "42" : '"topic"'} }`;
      const journal = store.open();
      const evaluator = createLuaEvaluator(runtime, {
        source: `return workflow.effect("lookup-site", ${payload})`,
        input: null,
        loadModule: () =>
          (compiled ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes))),
        decodeRequest: bindings.decodeRequest,
        decodeResult: (value) => value,
      });
      const recovery = createRecovery(runtime.composition, {
        name: "binding-recovery",
        program: "lua-bindings",
        matches: isDeepStrictEqual,
        acquire: evaluator.acquire,
      });
      const effects = createEffectCapabilities(runtime, "binding-effects");
      const grant = effects.grant(scenario === "ungranted" ? {} : { lookup: effect });
      const host = createHosting(runtime.composition, {
        name: "binding-host",
        recovery: recovery.operations,
        journal,
        attempts: journal.attempts,
        handle: grant.handle,
      });
      const task = runtime.start(function* () {
        yield* effects.install(effect, function* () {
          calls++;
          // Simulate an untyped external provider violating its declared response.
          return { ok: true, value: 42 as unknown as string };
        });
        yield* host.around(grant.admission);
        return yield* host.operations.run();
      });
      onTestFinished(() => task.cancel());
      await expect(task.result).rejects.toThrow(
        scenario === "unknown"
          ? "Unknown Lua effect binding"
          : scenario === "ungranted"
            ? "Effect is not granted"
            : scenario === "malformed"
              ? "Malformed Lua effect request"
              : "Effect schema rejected value",
      );
      expect(calls).toBe(scenario === "invalid-response" ? 1 : 0);
      expect(parses).toBe(
        scenario === "invalid-response" ? 2 : scenario === "invalid-input" ? 1 : 0,
      );
      const inspect = runtime.start(() => readJournal(journal));
      onTestFinished(() => inspect.cancel());
      expect((await inspect.result).history).toEqual([]);
    });
  }
});
