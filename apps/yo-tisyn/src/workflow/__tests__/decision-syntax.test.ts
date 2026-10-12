import { expect, it } from "vitest";
import { run } from "effection";
import { createTisynTool, parseProgram } from "../tisyn.ts";
import { parseTisynSource } from "../source.ts";
import { createEvaluation, TisynEvaluationPort } from "../evaluation/port.ts";
import { createNodeEvaluationDriver } from "../evaluation/node.ts";

it("requires the decision capability and pins its model binding", () => {
  const source = 'Classify({"input":"hello","instructions":"Choose","choices":{"a":"A","b":"B"}})';
  expect(() => parseProgram(source, [])).toThrow("Unsupported");
  expect(parseProgram(source, [], false, true)).toBeDefined();
  const one = createTisynTool([]).decisions({ provider: "opencode", id: "jev-1.13" }).build();
  const two = createTisynTool([]).decisions({ provider: "opencode", id: "other" }).build();
  expect(one.manifest.effects["model.decision"]).toBeDefined();
  expect(one.manifest.digest).not.toBe(two.manifest.digest);
  expect(() => parseProgram('Switch("a",{"a":1,"b":Eval("shell",{})},0)', [])).toThrow(
    "Unsupported",
  );
});

it("lowers nested switches hygienically, calls functions, and leaves text untouched", async () => {
  await run(function* () {
    yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
    const program =
      'Let("__switch_0",42,Let("f",Fn([],Ref("__switch_0")),Switch("a",{"a":Switch("b",{"b":Call(Ref("f"))},Throw("wrong")),"unused":Throw("wrong")},Throw("wrong"))))';
    const evaluation = yield* createEvaluation(parseProgram(program, []));
    expect(yield* evaluation.next()).toEqual({ done: true, value: 42 });
    expect(parseTisynSource('"Classify( Switch( )"')).toBe("Classify( Switch( )");
  });
});

it("evaluates the switch selector exactly once and only its selected branch", async () => {
  await run(function* () {
    yield* TisynEvaluationPort.installDriver(createNodeEvaluationDriver());
    const evaluation = yield* createEvaluation(
      parseTisynSource(
        'Switch(Eval("selector",{}),{"a":Eval("chosen",{}),"b":Eval("unused",{})},Eval("fallback",{}))',
      ),
    );
    expect(yield* evaluation.next()).toMatchObject({ done: false, value: { id: "selector" } });
    expect(yield* evaluation.next("a")).toMatchObject({ done: false, value: { id: "chosen" } });
    expect(yield* evaluation.next("done")).toEqual({ done: true, value: "done" });
  });
});

it.each([
  'Switch("a",{},0)',
  'Switch("a",{"a":1})',
  "Classify({})",
  'Classify({"input":"x","instructions":"Choose","choices":{"a":1}})',
])("rejects malformed syntax: %s", (source) => {
  expect(() => parseTisynSource(source)).toThrow(/Classify|Switch/);
});
