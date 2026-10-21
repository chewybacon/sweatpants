import { reviewDraft as schemeDraft } from "../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.artifact.mjs";
import { reviewDraft as luaDraft } from "../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.lua.artifact.mjs";
import { invokeWasm } from "@sweatpants/flowmode-runtime-lua/node";
import { schemeStack } from "./scheme.mjs";
import { createLuaStack } from "./lua.mjs";
import { createHootAuthoring } from "@sweatpants/flowmode-runtime-scheme/execution/authoring";
import { loadMachine } from "@sweatpants/flowmode-runtime-scheme/execution/machine";
import { createHootProgram } from "@sweatpants/flowmode-runtime-scheme/execution/driver";
import { executionServiceFactory } from "./service-core.mjs";
export const { createExecutionService, validateCaller, languages, authoring } =
  executionServiceFactory([
    schemeStack(
      createHootAuthoring({
        loadMachine,
        createProgram: createHootProgram,
      }),
      schemeDraft,
    ),
    createLuaStack(invokeWasm, luaDraft),
  ]);
