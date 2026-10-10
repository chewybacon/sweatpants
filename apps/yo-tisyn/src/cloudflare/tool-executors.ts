import { createToolExecutorObject } from "@sweatpants/tool-runtime-cloudflare/executor";
import variant from "@jitl/quickjs-wasmfile-release-sync";
import wasmModule from "#quickjs-wasm";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  memoizePromiseFactory,
} from "quickjs-emscripten-core";
import { TisynEvaluationPort } from "../evaluation.ts";
import { createQuickJSEvaluationDriver } from "../evaluation-quickjs.ts";
import { programs } from "./agent.ts";

const load = memoizePromiseFactory(() =>
  newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmModule })),
);

export const ToolExecutors = createToolExecutorObject({
  tools: programs,
  *setup() {
    yield* TisynEvaluationPort.installDriver(createQuickJSEvaluationDriver(load));
  },
});
