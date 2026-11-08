import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { createCodeAuthoring, createCodeValidator, type CodeSource } from "@sweatpan.ts/codemode";
import {
  createLuaValidator,
  createLuaKernel,
  defineLuaEffectBindings,
  luaWasmUrl,
} from "@sweatpan.ts/codemode-runtime-lua";
import { defineEffect, type CapabilityRequest } from "@sweatpan.ts/core";
import { createRecovery } from "@sweatpan.ts/durable";
import { createEffectCapabilities, createHosting } from "@sweatpan.ts/hosting";
import { createSqliteJournalRig } from "@sweatpan.ts/testing";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

let compiled: Promise<WebAssembly.Module> | undefined;
const loadModule = () =>
  (compiled ??= readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)));

forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: author, repair syntax, validate without effects, then host the same Lua source`, async () => {
    const lookup = defineEffect({ key: "code.lookup", context: z.string(), response: z.string() });
    const bindings = defineLuaEffectBindings({ lookup });
    const authoring = createCodeAuthoring(runtime, "code-authoring", {
      *describe({ bindings: catalog }) {
        return {
          language: "lua",
          instructions: `Use workflow.effect with these bindings: ${JSON.stringify(catalog)}`,
        };
      },
    });
    const validation = createCodeValidator(
      runtime,
      "code-validation",
      createLuaValidator(runtime, loadModule),
    );
    // Scripted authoring peer: invalid first response, then corrected source after diagnostics.
    const proposals: readonly CodeSource[] = [
      { language: "lua", text: "local =" },
      {
        language: "lua",
        text: 'local r = workflow.effect("lookup", { effect = "lookup", input = "flight" }); assert(r.ok); return r.value',
      },
    ];
    let calls = 0;
    const store = createSqliteJournalRig<string, CapabilityRequest, unknown, string, unknown, Y>({
      program: "authored-lua",
      equals: isDeepStrictEqual,
    });
    onTestFinished(() => store.close());
    const task = runtime.start(function* () {
      yield* authoring.around({
        *describe(args, next) {
          const guide = yield* next(...args);
          return { ...guide, instructions: `${guide.instructions} Return one JSON value.` };
        },
      });
      const guide = yield* authoring.operations.describe({
        bindings: [
          { name: "lookup", description: "Look up a flight", contract: "string -> string" },
        ],
      });
      expect(guide.instructions).toContain("lookup");
      expect(guide.instructions).toContain("Return one JSON value.");
      const rejected = yield* validation.operations.validate(proposals[0]!);
      expect(rejected.valid).toBe(false);
      expect(rejected.diagnostics[0]?.code).toBe("lua-source-rejected");
      const source = proposals[1]!;
      expect(yield* validation.operations.validate(source)).toEqual({
        valid: true,
        checked: ["source-budget", "syntax"],
        diagnostics: [],
      });
      // Runtime failure and unknown capability are valid syntax; validation cannot grant them.
      expect(
        (yield* validation.operations.validate({
          language: "lua",
          text: 'error("must not execute")',
        })).valid,
      ).toBe(true);
      expect(
        (yield* validation.operations.validate({
          language: "lua",
          text: "return unknown_capability()",
        })).valid,
      ).toBe(true);
      expect(calls).toBe(0);
      const kernel = createLuaKernel(runtime, {
        loadModule,
        decodeRequest: bindings.decodeRequest,
        decodeResult: (value) => z.string().parse(value),
      });
      const evaluator = yield* kernel.prepare(source.text, null);
      const journal = store.open();
      const recovery = createRecovery(runtime.composition, {
        name: "code-recovery",
        program: "authored-lua",
        matches: isDeepStrictEqual,
        acquire: evaluator.acquire,
      });
      const effects = createEffectCapabilities(runtime, "code-effects");
      const grant = effects.grant({ lookup });
      const host = createHosting(runtime.composition, {
        name: "code-host",
        recovery: recovery.operations,
        journal,
        attempts: journal.attempts,
        handle: grant.handle,
      });
      yield* effects.install(lookup, function* (topic) {
        calls++;
        return { ok: true, value: `${topic}: found` };
      });
      yield* host.around(grant.admission);
      const result = yield* host.operations.run();
      expect(calls).toBe(1);
      expect(result).toEqual({ state: "completed", value: "flight: found" });
      yield* host.operations.run();
      expect(calls).toBe(1);
    });
    onTestFinished(() => task.cancel());
    await task.result;
    const fresh = runtime.start(() => authoring.operations.describe({ bindings: [] }));
    onTestFinished(() => fresh.cancel());
    expect((await fresh.result).instructions).not.toContain("Return one JSON value.");
  });

  it(`${runtime.name}: validation policy is scoped and infrastructure errors are not source diagnostics`, async () => {
    const validation = createCodeValidator(
      runtime,
      "policy-validation",
      createLuaValidator(runtime, loadModule),
    );
    const source = { language: "lua", text: "return 1" };
    const task = runtime.start(function* () {
      expect(
        (yield* validation.operations.validate({ language: "scheme", text: "1" })).checked,
      ).toEqual([]);
      expect(
        (yield* validation.operations.validate({ language: "lua", text: "x".repeat(64_001) }))
          .checked,
      ).toEqual(["source-budget"]);
      yield* validation.around({
        *validate() {
          return {
            valid: false,
            checked: ["application-policy"],
            diagnostics: [{ code: "disabled", message: "Execution disabled", severity: "error" }],
          };
        },
      });
      expect((yield* validation.operations.validate(source)).valid).toBe(false);
    });
    onTestFinished(() => task.cancel());
    await task.result;
    const fresh = runtime.start(() => validation.operations.validate(source));
    onTestFinished(() => fresh.cancel());
    expect((await fresh.result).valid).toBe(true);
    const failed = createLuaValidator(runtime, () =>
      Promise.reject(new Error("loader unavailable")),
    );
    const attempt = runtime.start(() => failed.validate(source));
    onTestFinished(() => attempt.cancel());
    await expect(attempt.result).rejects.toThrow("loader unavailable");
  });
});
