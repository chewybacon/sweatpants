import { expect, it } from "vitest";
import { run } from "effection";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import { memoizePromiseFactory, newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import { createQuickJSEvaluationDriver, QUICKJS_LIMITS } from "../quickjs.ts";
import { parseProgram } from "../../tisyn.ts";
import { boundTools } from "../../agent.ts";
import fixture from "./fixtures/recursive-game.json" with { type: "json" };

const load = memoizePromiseFactory(() => newQuickJSWASMModuleFromVariant(variant));

it("completes and replays the authored program that overflowed before its nineteenth ask", async () => {
  expect(QUICKJS_LIMITS.stackBytes).toBe(128 * 1024);
  const ir = parseProgram(fixture.program, boundTools, true);
  const driver = createQuickJSEvaluationDriver(load);
  // A new compute VM reconstructs the same workflow from the same effect results.
  for (let replay = 0; replay < 2; replay++) {
    await run(function* () {
      const handle = yield* driver.open(ir);
      try {
        let step = yield* driver.advance(handle);
        for (let round = 1; round <= 20; round++) {
          expect(step).toMatchObject({ done: false, value: { id: "sample" } });
          step = yield* driver.advance(handle, { text: `Question ${round}?` });
          expect(step).toMatchObject({ done: false, value: { id: "ask" } });
          step = yield* driver.advance(handle, { action: "accept", content: { reply: "no" } });
        }
        expect(step).toMatchObject({
          done: true,
          value: { status: "out_of_questions", questionsUsed: 20 },
        });
      } finally {
        yield* driver.close(handle);
      }
    });
  }
});

it("executes a thousand pure tail calls under the unchanged VM bounds", async () => {
  const driver = createQuickJSEvaluationDriver(load);
  const ir = parseProgram(
    'Let("loop",Fn(["n"],If(Eq(Ref("n"),0),"done",Call(Ref("loop"),Sub(Ref("n"),1)))),Call(Ref("loop"),1000))',
    [],
  );
  await run(function* () {
    const handle = yield* driver.open(ir);
    try {
      expect(yield* driver.advance(handle)).toEqual({ done: true, value: "done" });
    } finally {
      yield* driver.close(handle);
    }
  });
});
