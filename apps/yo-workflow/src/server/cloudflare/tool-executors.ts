import luaWasm from "#execution-lua-wasm";
import { createWasmLuaInvoker } from "@sweatpants/flowmode-runtime-lua/wasm";
import { LuaEvaluationPort } from "@sweatpants/flowmode-runtime-lua";
import { SchemeEvaluationPort } from "@sweatpants/flowmode-runtime-scheme";
import { createWorkerSchemeDriver } from "@sweatpants/flowmode-runtime-scheme/worker";
import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";
import { programs } from "../../workflow/agent.ts";

export const ToolExecutors = createToolExecutorObject({
  tools: programs,
  *setup() {
    yield* LuaEvaluationPort.installDriver({ execute: createWasmLuaInvoker(async () => luaWasm) });
    yield* SchemeEvaluationPort.installDriver(createWorkerSchemeDriver());
  },
});
