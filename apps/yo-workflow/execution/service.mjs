import { createHootAuthoring } from "../../../experiments/workflow-kernel/hoot-composition/authoring.mjs";
import { loadMachine } from "../../../experiments/workflow-kernel/hoot-composition/machine.mjs";
import { createHootProgram } from "../../../experiments/workflow-kernel/hoot-composition/driver.mjs";
import { executionServiceFactory } from "./service-core.mjs";
export const { createExecutionService, validateCaller, developerSource } = executionServiceFactory(
    createHootAuthoring({
        loadMachine,
        createProgram: createHootProgram,
    }),
);
