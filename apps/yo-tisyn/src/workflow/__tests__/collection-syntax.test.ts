import variant from "@jitl/quickjs-wasmfile-release-sync";
import { memoizePromiseFactory, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { expect, it } from "vitest";
import { run } from "effection";
import { createQuickJSEvaluationDriver } from "../evaluation/quickjs.ts";
import { createNodeEvaluationDriver } from "../evaluation/node.ts";
import { createEvaluation, TisynEvaluationPort } from "../evaluation/port.ts";
import { evaluateJsonValue, JSON_VALUE_OPERATION } from "../json-values.ts";
import { parseTisynSource } from "../source.ts";
import { parseProgram, executeProgram } from "../tisyn.ts";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import type { Json } from "@sweatpants/foundation";

it.each(["node", "quickjs"])(
  "runs nested collection helpers without capturing names in %s",
  async (runtime) => {
    const result = await run(function* () {
      yield* TisynEvaluationPort.installDriver(
        runtime === "node"
          ? createNodeEvaluationDriver()
          : createQuickJSEvaluationDriver(
              memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant)),
            ),
      );
      return yield* executeProgram(
        `LetMany([
      ["__collection_0",10],
      ["items",[1,2,3]],
      ["items",Filter(Ref("items"),Fn(["item","index"],Gt(Ref("item"),1)))]],
      Construct({
        "mapped":Map(Ref("items"),Fn(["item","index"],Map([4,5],Fn(["inner","j"],Add(Add(Ref("item"),Ref("inner")),Ref("__collection_0")))))),
        "folded":Reduce(Ref("items"),0,Fn(["acc","item","index"],Add(Ref("acc"),Mul(Ref("item"),Add(Ref("index"),1))))),
        "empty":Map([],Fn(["item","index"],Throw("must not run")))
      }))`,
        [],
        {} as DurableProgramContext,
      );
    });
    expect(result).toEqual({
      mapped: [
        [16, 17],
        [17, 18],
      ],
      folded: 8,
      empty: [],
    });
  },
);

it.each(["node", "quickjs"])(
  "evaluates effectful inputs and callbacks once, in order, on replay in %s",
  async (runtime) => {
    const source = `LetMany([["offset",10]],Reduce(Eval("items",{}),Eval("initial",{}),Seq(Eval("callback",{}),Fn(["acc","item","index"],Eval("visit",Construct({"acc":Ref("acc"),"item":Ref("item"),"index":Ref("index"),"offset":Ref("offset")}))))))`;
    for (let replay = 0; replay < 2; replay++) {
      const effects: unknown[] = [];
      const result = await run(function* () {
        yield* TisynEvaluationPort.installDriver(
          runtime === "node"
            ? createNodeEvaluationDriver()
            : createQuickJSEvaluationDriver(
                memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant)),
              ),
        );
        const execution = yield* createEvaluation(parseTisynSource(source));
        let step = yield* execution.next();
        while (!step.done) {
          const { id, data } = step.value;
          let value: Json;
          if (id === JSON_VALUE_OPERATION) {
            value = evaluateJsonValue(data);
          } else {
            effects.push({ id, data });
            if (id === "items") {
              value = [2, 4];
            } else if (id === "initial") {
              value = 1;
            } else if (id === "callback") {
              value = null;
            } else {
              value = (data as { acc: number; item: number }).acc + (data as { item: number }).item;
            }
          }
          step = yield* execution.next(value);
        }
        return step.value;
      });
      expect(effects).toEqual([
        { id: "items", data: {} },
        { id: "initial", data: {} },
        { id: "callback", data: {} },
        { id: "visit", data: { acc: 1, item: 2, index: 0, offset: 10 } },
        { id: "visit", data: { acc: 3, item: 4, index: 1, offset: 10 } },
      ]);
      expect(result).toBe(7);
    }
  },
);

it("retains recursive function bindings and short-circuit branches", async () => {
  const result = await run(function* () {
    yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
    return yield* executeProgram(
      'LetMany([["loop",Fn(["n"],If(Eq(Ref("n"),0),Map([1],Fn(["x","i"],Ref("x"))),Call(Ref("loop"),Sub(Ref("n"),1))))]],Call(Ref("loop"),1000))',
      [],
      {} as DurableProgramContext,
    );
  });
  expect(result).toEqual([1]);
});

it.each([
  ['LetMany({"x":1},Ref("x"))', "pairs"],
  ['LetMany([["x"]],0)', "binding"],
  ["Map([1])", "callback"],
  ["Reduce([],0)", "callback"],
  ['Map([],Fn(["x"],Ref("x")))', "expected 1 arguments, got 2"],
  ['WithMacros({"M":{"params":[],"body":LetMany([["x",1]],0)}},Use("M"))', "cannot introduce"],
  ['Map([],Fn(["x","i"],Eval("shell",{})))', "Unsupported"],
])("rejects invalid authoring before effects: %s", (source, message) => {
  expect(() => parseProgram(source, [])).toThrow(message);
});

it.each(['Map("",Fn(["x","i"],Ref("x")))', 'Filter({},Fn(["x","i"],true))'])(
  "rejects non-array input, including empty strings: %s",
  async (source) => {
    await expect(
      run(function* () {
        yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
        return yield* executeProgram(source, [], {} as DurableProgramContext);
      }),
    ).rejects.toThrow("must be an array");
  },
);
