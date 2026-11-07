// Manual compiler integration: ScriptC owns a subprocess, so keep outside acceptance.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRuntime as effectRuntime } from "../../../packages/v2/runtime-effect/src/index.ts";
import { createRuntime as effectionRuntime } from "../../../packages/v2/runtime-effection/src/index.ts";
import {
  createLuaKernel,
  luaWasmUrl,
} from "../../../packages/v2/codemode-runtime-lua/src/index.ts";
import { compileWorkflow } from "./live.mjs";
import { input, outcomeInput } from "./input.mjs";
import { luaWorkflowLinker, bindLuaReviewBoundary } from "./lua-target.mts";
const bytes = await readFile(luaWasmUrl);
const identity = createHash("sha256").update(bytes).digest("hex");
const wasm = await WebAssembly.compile(bytes);
const caller = 'local result = review_draft(input) return "caller:" .. result';
let passed = 0;
for (const [label, source, expected] of [
  ["original", input, "caller:approved:yes"],
  ["outcome", outcomeInput, "caller:approved:yes"],
  ["rejection", outcomeInput, "caller:rejected:denied"],
  [
    "edited",
    {
      ...input,
      source: { ...input.source, text: input.source.text.replace("'approved:'", "'published:'") },
    },
    "caller:published:yes",
  ],
]) {
  const module = JSON.parse(JSON.stringify(compileWorkflow(source).module));
  const artifact = luaWorkflowLinker.link({
    module,
    caller: { language: "lua", text: caller },
    name: "review_draft",
    identity,
  });
  for (const runtime of [effectRuntime(), effectionRuntime()]) {
    for (const cancellation of ["none", "body", "cleanup"]) {
      await runtime.start(function* () {
        const kernel = createLuaKernel(runtime, {
          loadModule: async () => wasm,
          decodeRequest: bindLuaReviewBoundary(module, [
            "scriptc.review.approval",
            "scriptc.review.cleanup",
          ]),
          decodeResult: (value) => value,
        });
        const recipe = yield* kernel.prepare(artifact.source, "draft");
        const guest = yield* recipe.acquire();
        yield* runtime.composition.ensure(() => guest.close());
        assert.deepEqual((yield* guest.start()).request, {
          effect: "scriptc.review.approval",
          input: { message: "approve:draft" },
        });
        const state = yield* recipe.checkpoints.capture(guest);
        yield* guest.close();
        const next = yield* kernel.prepare(artifact.source, "draft");
        const restored = yield* next.checkpoints.restore(state);
        yield* runtime.composition.ensure(() => restored.guest.close());
        let cleanup =
          cancellation === "body"
            ? yield* restored.guest.cancel("stop")
            : yield* restored.guest.resume({
                ok: true,
                value:
                  label === "rejection"
                    ? { ok: false, error: "denied" }
                    : { ok: true, value: "yes" },
              });
        assert.equal(cleanup.kind, "suspended");
        assert.equal(cleanup.scope.phase, "cleanup");
        assert.deepEqual(cleanup.request, {
          effect: "scriptc.review.cleanup",
          input: {
            message:
              cancellation === "body" || ["outcome", "rejection"].includes(label)
                ? "release:draft"
                : "release:yes",
          },
        });
        if (cancellation !== "none") {
          cleanup = yield* restored.guest.cancel("stop");
          assert.deepEqual(yield* restored.guest.cancel("again"), cleanup);
        }
        const saved = yield* next.checkpoints.capture(restored.guest);
        yield* restored.guest.close();
        const finalRecipe = yield* kernel.prepare(artifact.source, "draft");
        const final = yield* finalRecipe.checkpoints.restore(saved);
        yield* runtime.composition.ensure(() => final.guest.close());
        assert.deepEqual(final.turn, cleanup);
        assert.deepEqual(
          yield* final.guest.resume({ ok: true, value: { ok: true, value: "released" } }),
          cancellation === "none"
            ? { kind: "completed", value: expected }
            : { kind: "cancelled", reason: "stop", failure: undefined },
        );
      }).result;
      passed++;
      console.log(`${runtime.name}: ${label}, ${cancellation} — passed`);
    }
  }
}
console.log(`${passed} live ScriptC → shared S-expression IR → linked Lua journeys passed`);
