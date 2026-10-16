import { expect, it } from "vitest";
import { parseTisynSource } from "../source.ts";

it("rejects a known recursive call's wrong arity before effects", () => {
  expect(() =>
    parseTisynSource(
      'Let("f",Fn(["x","n"],Seq(Eval("ask",{}),Call(Ref("f"),Ref("x")))),Call(Ref("f"),"",0))',
    ),
  ).toThrow("expected 2 arguments, got 1");
});

it("rejects double-unwrapping Classify through a binding", () => {
  expect(() =>
    parseTisynSource(
      'Let("result",Classify({"input":"x","instructions":"Choose","choices":{"a":"A","b":"B"}}),Get(Ref("result"),"answer"))',
    ),
  ).toThrow("returns the answer directly");
});

it("allows correct answer access and unknown effect values", () => {
  expect(() =>
    parseTisynSource(
      'Let("result",Classify({"input":"x","instructions":"Choose","choices":{"a":"A","b":"B"}}),Get(Ref("result"),"choice"))',
    ),
  ).not.toThrow();
  expect(() => parseTisynSource('Get(Eval("custom",{}),"answer")')).not.toThrow();
});

it("uses caller bindings and respects parameter shadowing", () => {
  expect(() =>
    parseTisynSource(
      'Let("f",Fn(["x"],Ref("x")),Let("g",Fn(["f"],Call(Ref("f"),1,2)),Call(Ref("g"),Fn(["a","b"],Ref("a")))))',
    ),
  ).not.toThrow();
});

it("allows recursion and does not interpret quoted data as code", () => {
  expect(() =>
    parseTisynSource(
      'Let("f",Fn(["n"],If(Eq(Ref("n"),0),0,Call(Ref("f"),Sub(Ref("n"),1)))),Call(Ref("f"),3))',
    ),
  ).not.toThrow();
});
