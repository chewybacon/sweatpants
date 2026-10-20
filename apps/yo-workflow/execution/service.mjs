import { reviewDraft as schemeDraft } from "../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.artifact.mjs";
import { reviewDraft as luaDraft } from "../../../experiments/workflow-kernel/tsdown-authoring/dist/review-draft.workflow.lua.artifact.mjs";
import { invokeWasm } from "../../../experiments/workflow-kernel/teal-lua-checkpoint/wasm-node.mts";
import { schemeStack } from "./scheme.mjs";
import { createLuaStack } from "./lua.mjs";
import { createHootAuthoring } from "../../../experiments/workflow-kernel/hoot-composition/authoring.mjs";
import { loadMachine } from "../../../experiments/workflow-kernel/hoot-composition/machine.mjs";
import { createHootProgram } from "../../../experiments/workflow-kernel/hoot-composition/driver.mjs";
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
