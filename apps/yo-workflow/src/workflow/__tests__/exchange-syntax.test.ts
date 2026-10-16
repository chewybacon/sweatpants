import { expect, it } from "vitest";
import { evaluate, EMPTY_ENV } from "@tisyn/kernel";
import { parseTisynSource } from "../source.ts";
import { parseProgram } from "../tisyn.ts";

it("evaluates an elicitation once, binds its accepted exchange, and skips the stop branch", () => {
  const ir = parseTisynSource(
    'OnAccepted(Ask({"message":"Name?"}),Fn(["content","exchange"],Construct({"reply":Ref("content"),"history":Arr(Ref("exchange"))})),Fn(["stop"],Eval("unused",{})))',
  );
  const execution = evaluate(ir, EMPTY_ENV);
  expect(execution.next()).toEqual({
    done: false,
    value: { id: "ask", data: { message: "Name?" } },
  });
  const exchange = { messages: [] };
  expect(execution.next({ action: "accept", content: { reply: "Ada" }, exchange })).toEqual({
    done: true,
    value: { reply: { reply: "Ada" }, history: [exchange] },
  });
});

it.each(["decline", "cancel"])("passes %s to the stop branch without reading content", (action) => {
  const execution = evaluate(
    parseTisynSource(
      'OnAccepted(Ask({"message":"Name?"}),Fn(["content","exchange"],Eval("unused",{})),Fn(["stop"],Ref("stop")))',
    ),
    EMPTY_ENV,
  );
  execution.next();
  expect(execution.next({ action })).toEqual({ done: true, value: { action } });
});

it("lowers static schemas and binds a structured sample without capturing caller names", () => {
  const source =
    'Let("__exchange_0",42,OnParsed(Sample({"prompt":"Interpret","schema":ObjectSchema({"kind":EnumSchema("answer","clarify"),"value":StringSchema(),"items":ArraySchema(IntegerSchema())})}),Fn(["value","exchange"],Construct({"value":Ref("value"),"outer":Ref("__exchange_0")})),Fn(["error"],Eval("unused",{}))))';
  const execution = evaluate(parseTisynSource(source), EMPTY_ENV);
  expect(execution.next()).toEqual({
    done: false,
    value: {
      id: "sample",
      data: {
        prompt: "Interpret",
        schema: {
          type: "object",
          properties: {
            kind: { enum: ["answer", "clarify"] },
            value: { type: "string" },
            items: { type: "array", items: { type: "integer" } },
          },
          required: ["kind", "value", "items"],
          additionalProperties: false,
        },
      },
    },
  });
  expect(
    execution.next({
      status: "ok",
      parsed: { kind: "answer", value: "Ada", items: [1] },
      exchange: { messages: [] },
    }),
  ).toEqual({
    done: true,
    value: { value: { kind: "answer", value: "Ada", items: [1] }, outer: 42 },
  });
});

it("routes invalid structured output to the repair callback", () => {
  const execution = evaluate(
    parseTisynSource(
      'OnParsed(Sample({"prompt":"Interpret","schema":StringSchema()}),Fn(["value","exchange"],Eval("unused",{})),Fn(["error"],Get(Ref("error"),"message")))',
    ),
    EMPTY_ENV,
  );
  execution.next();
  expect(execution.next({ status: "invalid", parseError: { message: "Expected string" } })).toEqual(
    { done: true, value: "Expected string" },
  );
});

it("preserves capability admission and callback arity diagnostics", () => {
  expect(() => parseProgram('Ask({"message":"Name?"})', [])).toThrow("Unsupported");
  expect(() => parseTisynSource('OnAccepted(Ask({}),Fn(["x"],0),Fn(["stop"],0))')).toThrow(
    "2 parameters",
  );
  expect(() => parseTisynSource('OnParsed(Sample({}),Fn(["x","e"],0),Fn([],0))')).toThrow(
    "1 parameters",
  );
  expect(() => parseTisynSource('ObjectSchema({"name":Ref("schema")})')).toThrow();
});

it("accepts computed requests just like the underlying effect", () => {
  const execution = evaluate(
    parseTisynSource(
      'Let("prompt","Interpret",Sample(Construct({"prompt":Ref("prompt"),"schema":StringSchema()})))',
    ),
    EMPTY_ENV,
  );
  expect(execution.next()).toEqual({
    done: false,
    value: { id: "sample", data: { prompt: "Interpret", schema: { type: "string" } } },
  });
  expect(execution.next({ status: "ok", parsed: "hello", exchange: { messages: [] } })).toEqual({
    done: true,
    value: { status: "ok", parsed: "hello", exchange: { messages: [] } },
  });
});

it("composes named callback functions without wrapper lambdas", () => {
  const execution = evaluate(
    parseTisynSource(
      'LetMany([["accept",Fn(["content","exchange"],Get(Ref("content"),"reply"))],["stop",Fn(["result"],Ref("result"))]],OnAccepted(Ask({"message":"Word?"}),Ref("accept"),Ref("stop")))',
    ),
    EMPTY_ENV,
  );
  expect(execution.next().value).toEqual({ id: "ask", data: { message: "Word?" } });
  expect(
    execution.next({ action: "accept", content: { reply: "hello" }, exchange: { messages: [] } }),
  ).toEqual({ done: true, value: "hello" });
});

it.each([
  [{ status: "ok", parsed: "hello", exchange: { messages: [] } }, "hello"],
  [{ status: "invalid", parseError: { message: "Try again" } }, "Try again"],
])("selects named structured-sample callbacks lazily", (result, expected) => {
  const execution = evaluate(
    parseTisynSource(
      'LetMany([["accept",Fn(["value","exchange"],Ref("value"))],["repair",Fn(["error"],Get(Ref("error"),"message"))]],OnParsed(Sample({"prompt":"Interpret","schema":StringSchema()}),Ref("accept"),Ref("repair")))',
    ),
    EMPTY_ENV,
  );
  expect(execution.next().value).toMatchObject({ id: "sample" });
  expect(execution.next(result)).toEqual({ done: true, value: expected });
});
