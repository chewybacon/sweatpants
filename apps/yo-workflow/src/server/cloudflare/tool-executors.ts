import luaWasm from "#execution-lua-wasm";
import { createWasmLuaInvoker } from "../../../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm.mts";
import { LuaEvaluationPort } from "../../workflow/lua/evaluation.ts";
import { SchemeEvaluationPort } from "@sweatpants/scheme-runtime";
import { createWorkerSchemeDriver } from "@sweatpants/scheme-runtime/worker";
import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";
import { programs } from "../../workflow/agent.ts";

export const ToolExecutors = createToolExecutorObject({
  tools: programs,
  *setup() {
    yield* LuaEvaluationPort.installDriver({ execute: createWasmLuaInvoker(async () => luaWasm) });
    yield* SchemeEvaluationPort.installDriver(createWorkerSchemeDriver());
  },
});
