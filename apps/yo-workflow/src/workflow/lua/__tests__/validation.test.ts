import { expect, it } from "vitest";
import { run } from "effection";
import type { DurableProgramContext } from "@sweatpants/durable-execution";
import { createLuaTool } from "../tool.ts";
import { LuaEvaluationPort } from "../evaluation.ts";
import { invokeWasm } from "../../../../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm-node.mts";

it("validates syntax without dispatching effects and exposes repair diagnostics", async () => {
  const tool = createLuaTool([]);
  const context = new Proxy({} as DurableProgramContext, {
    get() {
      throw new Error("Validation dispatched an effect");
    },
  });
  await run(function* () {
    yield* LuaEvaluationPort.installDriver({ execute: invokeWasm });
    expect(
      yield* tool.program(
        { program: 'return random({choices={"a","b"}})', validateOnly: true },
        context,
      ),
    ).toMatchObject({ status: "valid" });
    expect(yield* tool.program({ program: "local =", validateOnly: true }, context)).toMatchObject({
      status: "invalid",
      completedEffects: 0,
      diagnostic: { message: expect.any(String) },
    });
  });
});
it("fails closed when the Lua driver is missing", async () => {
  await expect(
    run(() =>
      createLuaTool([]).program(
        { program: "return 1", validateOnly: true },
        {} as DurableProgramContext,
      ),
    ),
  ).rejects.toThrow("Lua evaluation driver is not installed");
});
