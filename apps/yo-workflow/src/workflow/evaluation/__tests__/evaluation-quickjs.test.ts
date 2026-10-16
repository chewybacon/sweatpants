import { describe, expect, it } from "vitest";
import { run, scoped } from "effection";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { memoizePromiseFactory, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createQuickJSEvaluationDriver } from "../quickjs.ts";
import { createEvaluation, TisynEvaluationPort } from "../port.ts";
import { parseProgram } from "../../tisyn.ts";
import { boundTools } from "../../agent.ts";

const load = memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant));

describe("published kernel in bounded QuickJS compute", () => {
  it.each([
    ["While(true, [1])", /compute interrupts/],
    ["While(true, [])", /compute interrupts/],
    ['Let("loop",Fn([],Call(Ref("loop"))),Call(Ref("loop")))', /stack overflow|compute interrupts/],
    [
      'Let("grow",Fn(["s"],Call(Ref("grow"),Concat(Ref("s"),Ref("s")))),Call(Ref("grow"),"x"))',
      /out of memory/,
    ],
    ["Mul(1e308,1e308)", /non-JSON/],
    ['Throw("expected failure")', /expected failure/],
  ])("fails explicitly for %s and leaves subsequent evaluation usable", async (source, failure) => {
    const driver = createQuickJSEvaluationDriver(load);
    const handle = await run(() => driver.open(parseProgram(source, boundTools)));
    await expect(run(() => driver.advance(handle))).rejects.toThrow(failure);
    await expect(run(() => driver.advance(handle))).rejects.toThrow("Unknown or closed");
    await run(() => driver.close(handle));
    const next = await run(() => driver.open(parseProgram("42", boundTools)));
    expect(await run(() => driver.advance(next))).toEqual({ done: true, value: 42 });
  });

  it("keeps independent sessions and cleans parked sessions on scope exit", async () => {
    const driver = createQuickJSEvaluationDriver(load);
    await run(function* () {
      yield* TisynEvaluationPort.installDriver(driver);
      const handles: string[] = [];
      yield* TisynEvaluationPort.api.around({
        *open(args, next) {
          const handle = yield* next(...args);
          handles.push(handle);
          return handle;
        },
      });
      const first = yield* driver.open(
        parseProgram('Eval("echo",{"message":"first"})', boundTools),
      );
      yield* scoped(function* () {
        const second = yield* createEvaluation(
          parseProgram('Eval("echo",{"message":"second"})', boundTools),
        );
        expect(yield* second.next()).toEqual({
          done: false,
          value: { id: "echo", data: { message: "second" } },
        });
      });
      expect(yield* driver.advance(first)).toEqual({
        done: false,
        value: { id: "echo", data: { message: "first" } },
      });
      expect(yield* driver.advance(first, { message: "first" })).toEqual({
        done: true,
        value: { message: "first" },
      });
      for (const handle of handles) {
        let failure: unknown;
        try {
          yield* driver.advance(handle);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("Unknown or closed");
      }
    });
  });

  it("runs 25 recursive rounds without reauthoring or leaking transport coercions", async () => {
    await run(function* () {
      yield* TisynEvaluationPort.installDriver(createQuickJSEvaluationDriver(load));
      const program = yield* createEvaluation(
        parseProgram(
          'Let("loop",Fn(["n"],If(Eq(Ref("n"),0),"done",Seq(Eval("echo",{"message":Concat("round ",Ref("n"))}),Call(Ref("loop"),Sub(Ref("n"),1))))),Call(Ref("loop"),25))',
          boundTools,
        ),
      );
      for (let n = 25; n > 0; n--) {
        expect(yield* program.next({ message: "reply" })).toEqual({
          done: false,
          value: { id: "echo", data: { message: `round ${n}` } },
        });
      }
      expect(yield* program.next({ message: "reply" })).toEqual({ done: true, value: "done" });
    });
  });
});
