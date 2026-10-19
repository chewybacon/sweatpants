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
    ),
    createLuaStack(invokeWasm),
  ]);
