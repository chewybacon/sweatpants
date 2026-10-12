import { expect, it } from "vitest";
import { evaluate, EMPTY_ENV } from "@tisyn/kernel";
import { parseProgram } from "../tisyn.ts";
import { parseTisynSource } from "../source.ts";

it("provides lazy When and Unless forms", () => {
  const ir = parseTisynSource('Seq(When(false,Eval("unused",{})),Unless(false,Eval("chosen",{})))');
  const execution = evaluate(ir, EMPTY_ENV);
  expect(execution.next()).toEqual({ done: false, value: { id: "chosen", data: {} } });
  expect(execution.next("done")).toEqual({ done: true, value: "done" });
});

it("expands an authored macro before evaluation and preserves caller bindings", () => {
  const source =
    'WithMacros({"Unless":{"params":["condition","body"],"body":If(Hole("condition"),null,Hole("body"))}},Let("message","hello",Use("Unless",false,Ref("message"))))';
  const ir = parseProgram(source, []);
  expect(JSON.stringify(ir)).not.toContain("__macro_");
  expect(evaluate(ir, EMPTY_ENV).next()).toEqual({ done: true, value: "hello" });
});

it("composes macros with decision syntax and validates expanded capabilities", () => {
  const source =
    'WithMacros({"Choose":{"params":["value"],"body":Switch(Hole("value"),{"a":42},0)}},Use("Choose","a"))';
  expect(evaluate(parseProgram(source, []), EMPTY_ENV).next()).toEqual({ done: true, value: 42 });
  expect(() => parseProgram('Unless(true,Eval("shell",{}))', [])).toThrow("Unsupported");
});

it("substitutes syntax by name: duplicate holes repeat effects, and replay expands identically", () => {
  const source =
    'WithMacros({"Twice":{"params":["body"],"body":Seq(Hole("body"),Hole("body"))}},Use("Twice",Eval("work",{})))';
  const original = parseTisynSource(source);
  for (let replay = 0; replay < 2; replay++) {
    const ir = parseTisynSource(source);
    expect(ir).toEqual(original);
    const execution = evaluate(ir, EMPTY_ENV);
    expect(execution.next()).toEqual({ done: false, value: { id: "work", data: {} } });
    expect(execution.next("first")).toEqual({ done: false, value: { id: "work", data: {} } });
    expect(execution.next("second")).toEqual({ done: true, value: "second" });
  }
});

it("does not treat quoted constructor text as syntax", () => {
  expect(parseTisynSource('"When( Unless( Hole( Use("')).toBe("When( Unless( Hole( Use(");
});

it.each([
  ['Hole("x")', "only valid"],
  ['Use("missing",1)', "Unknown macro"],
  ["When(true)", "require"],
  ['WithMacros({"M":{"params":["x","x"],"body":0}},0)', "unique strings"],
  ['WithMacros({"M":{"params":[],"body":Hole("x")}},0)', "declared"],
  ['WithMacros({"M":{"params":[],"body":Ref("x")}},0)', "cannot introduce"],
  ['WithMacros({"M":{"params":[],"body":Let("x",1,2)}},0)', "cannot introduce"],
  ['WithMacros({"M":{"params":[],"body":Fn([],0)}},0)', "cannot introduce"],
  ['WithMacros({"M":{"params":[],"body":0}},Use("M",1))', "requires 0"],
  ['WithMacros({"M":{"params":[],"body":Use("M")}},Use("M"))', "exceeds"],
])("rejects invalid or unbounded macro source: %s", (source, message) => {
  expect(() => parseProgram(source, [])).toThrow(message);
});
