import variant from "@jitl/quickjs-wasmfile-release-sync";
import { memoizePromiseFactory, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createQuickJSEvaluationDriver } from "../evaluation/quickjs.ts";
import { expect, it } from "vitest";
import { run } from "effection";
import { evaluateJsonValue } from "../json-values.ts";
import { executeProgram, parseProgram } from "../tisyn.ts";
import { TisynEvaluationPort } from "../evaluation/port.ts";
import { createNodeEvaluationDriver } from "../evaluation/node.ts";
import type { DurableProgramContext } from "@sweatpants/durable-execution";

it.each(["node", "quickjs"])(
  "evaluates computed collection operations without durable effects in %s",
  async (runtime) => {
    const result = await run(function* () {
      yield* TisynEvaluationPort.installDriver(
        runtime === "node"
          ? createNodeEvaluationDriver()
          : createQuickJSEvaluationDriver(
              memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant)),
            ),
      );
      const context = new Proxy(
        {},
        {
          get() {
            throw new Error("Pure values accessed durable context");
          },
        },
      );
      return yield* executeProgram(
        'Let("items",JsonAppend([1,2],3),Let("updated",JsonSet(Ref("items"),1,9),Construct({"item":JsonGet(Ref("updated"),Add(0,1)),"length":JsonLength(Ref("updated")),"text":JsonStringify(Ref("updated")),"original":Ref("items"),"keys":JsonKeys({"a":1})})))',
        [],
        context as DurableProgramContext,
      );
    });
    expect(result).toEqual({
      item: 9,
      length: 3,
      text: "[1,9,3]",
      original: [1, 2, 3],
      keys: ["a"],
    });
  },
);

it("rejects unsafe paths, invalid indices, and oversized values", () => {
  expect(() => evaluateJsonValue({ op: "get", args: [{}, "__proto__"] })).toThrow("Unsafe");
  expect(() => evaluateJsonValue({ op: "set", args: [[1], 2, 3] })).toThrow("bounds");
  expect(() => evaluateJsonValue({ op: "append", args: [[], "x".repeat(32768)] })).toThrow(
    "32 KiB",
  );
});

it("bounds pure-operation loops independently of the tool-call budget", async () => {
  await expect(
    run(function* () {
      yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
      return yield* executeProgram(
        'Let("loop",Fn([],Seq(JsonLength([]),Call(Ref("loop")))),Call(Ref("loop")))',
        [],
        {} as DurableProgramContext,
      );
    }),
  ).rejects.toThrow("4096 JSON operations");
});

it("admits collection-heavy programs within the bounded authoring profile", () => {
  const item = 'Construct({"index":1,"value":JsonGet([1],0)})';
  const source = `Arr(${Array.from({ length: 64 }, () => item).join(",")})`;
  expect(() => parseProgram(source, [])).not.toThrow();
  const oversized = `Arr(${Array.from({ length: 64 }, () => `[${Array.from({ length: 64 }, () => 1).join(",")}]`).join(",")})`;
  expect(() => parseProgram(oversized, [])).toThrow(/exceeds 4000 values/);
});
