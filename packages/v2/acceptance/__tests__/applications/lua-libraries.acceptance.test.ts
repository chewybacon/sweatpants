import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  createLuaEvaluator,
  luaLibraryWasmUrl,
  luaWasmUrl,
} from "@sweatpan.ts/codemode-runtime-lua";
import type { Runtime } from "@sweatpan.ts/runtime";
import { forEachRuntime } from "../runtime/assembly.ts";

const loadModule = () => readFile(luaLibraryWasmUrl).then((bytes) => WebAssembly.compile(bytes));
const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const expected = [...alphabet].flatMap((a) => [...alphabet].map((b) => a + b)).join(" ");
const programs = [
  `local chars = "${alphabet}" local out = {} for i=1,52 do for j=1,52 do out[#out+1] = string.sub(chars,i,i) .. string.sub(chars,j,j) end end return table.concat(out," ")`,
  `local out = {} for i=1,26 do for j=1,26 do local a=string.char(96+i) local b=string.char(96+j) out[#out+1]=a..b out[#out+1]=a..string.char(64+j) out[#out+1]=string.char(64+i)..b out[#out+1]=string.char(64+i)..string.char(64+j) end end return table.concat(out," ")`,
  `local chars = {${[...alphabet].map((c) => JSON.stringify(c)).join(",")}} local out = {} for i=1,52 do for j=1,52 do out[#out+1]=chars[i]..chars[j] end end return table.concat(out," ")`,
];
forEachRuntime(<Y>(runtime: Runtime<Y>) => {
  it(`${runtime.name}: the three failed chat programs produce all 2704 pairs`, async () => {
    for (const source of programs) {
      const result = await runtime.start(function* () {
        const evaluator = createLuaEvaluator(runtime, {
          source,
          input: null,
          loadModule,
          decodeRequest: (value) => value,
          decodeResult: (value) => String(value),
        });
        const guest = yield* evaluator.acquire();
        try {
          return yield* guest.start();
        } finally {
          yield* guest.close();
        }
      }).result;
      expect(result.kind).toBe("completed");
      if (result.kind === "completed") {
        expect(result.value.split(" ").sort()).toEqual(expected.split(" ").sort());
      }
    }
  });
  it(`${runtime.name}: concatenation rejects oversized native work and preserves empty ranges`, async () => {
    await runtime.start(function* () {
      const evaluator = createLuaEvaluator(runtime, {
        source: `local ok, failure = pcall(function() return table.concat({}, "", 1, 10001) end)
assert(not ok)
local big = "1234567890" for i=1,17 do big=big..big end
local bytesOk, bytesFailure = pcall(function() return table.concat({big}) end)
assert(not bytesOk)
return {count=failure, bytes=bytesFailure, empty=table.concat({}, ","), range=table.concat({"a","b","c"}, ":", 2, 3)}`,
        input: null,
        loadModule,
        decodeRequest: (value) => value,
        decodeResult: (value) => value,
      });
      const guest = yield* evaluator.acquire();
      try {
        expect(yield* guest.start()).toMatchObject({
          kind: "completed",
          value: {
            count: "table.concat supports at most 10000 values",
            bytes: "table.concat exceeds 1MiB output budget",
            empty: "",
            range: "b:c",
          },
        });
      } finally {
        yield* guest.close();
      }
    }).result;
  });
  for (const cancel of [false, true]) {
    it(`${runtime.name}: library callbacks survive checkpoint disposal and ${cancel ? "cleanup" : "resume"}`, async () => {
      await runtime.start(function* () {
        const source = `local sub, char, concat = string.sub, string.char, table.concat
return workflow.scope(function()
  workflow.effect("approval", { value = sub("abc", 2, 3) })
  return concat({sub("abc", -2), char(65,66)}, ":")
end, function()
  workflow.effect("cleanup", { value = concat({char(67), sub("done",1,2)}, ":") })
end)`;
        const options = {
          source,
          input: null,
          loadModule,
          decodeRequest: (value: unknown) => value,
          decodeResult: (value: unknown) => value,
        };
        const evaluator = createLuaEvaluator(runtime, options);
        const guest = yield* evaluator.acquire();
        expect(yield* guest.start()).toMatchObject({
          kind: "suspended",
          request: { site: "approval", request: { value: "bc" } },
        });
        const checkpoint = yield* evaluator.checkpoints.capture(guest);
        yield* guest.close();
        // A different VM generation must not silently reinterpret native indices.
        const legacy = createLuaEvaluator(runtime, {
          ...options,
          loadModule: () => readFile(luaWasmUrl).then((bytes) => WebAssembly.compile(bytes)),
        });
        let rejected = false;
        try {
          yield* legacy.checkpoints.restore(checkpoint);
        } catch (error) {
          rejected = String(error).includes("source/runtime mismatch");
        }
        expect(rejected).toBe(true);
        const restored = yield* evaluator.checkpoints.restore(checkpoint);
        try {
          if (!restored.guest.cancel) {
            throw new Error("Lua cancellation is unavailable");
          }
          const cleanup = cancel
            ? yield* restored.guest.cancel("stop")
            : yield* restored.guest.resume({ ok: true, value: null });
          expect(cleanup).toMatchObject({
            kind: "suspended",
            request: { site: "cleanup", request: { value: "C:do" } },
          });
          const savedCleanup = yield* evaluator.checkpoints.capture(restored.guest);
          yield* restored.guest.close();
          const resumed = yield* evaluator.checkpoints.restore(savedCleanup);
          try {
            expect(yield* resumed.guest.resume({ ok: true, value: null })).toEqual(
              cancel
                ? { kind: "cancelled", reason: "stop", failure: undefined }
                : { kind: "completed", value: "bc:AB" },
            );
          } finally {
            yield* resumed.guest.close();
          }
        } finally {
          yield* restored.guest.close();
        }
      }).result;
    });
  }
});
