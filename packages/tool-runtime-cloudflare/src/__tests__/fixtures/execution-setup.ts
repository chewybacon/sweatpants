import { definePort } from "@sweatpants/foundation/port";
import { CrankError } from "@sweatpants/durable-execution";
import { DURABLE_DRIVER_FIXTURE_TOOLS } from "@sweatpants/journal-authority/testing";
import type { Operation } from "effection";

const ExecutionServices = definePort<{ ready(): Operation<void> }>("executor-test-services", {
  *ready() {
    throw new CrankError("execution_setup_missing", "Setup did not run in the program scope");
  },
});

export function* installExecutionServices() {
  yield* ExecutionServices.installDriver({ *ready() {} });
}

// Retain the conformance tools' real programs and outputs. Every existing replay,
// cancellation, and cleanup scenario now also requires executor-owned installation.
export const toolsWithExecutionServices = DURABLE_DRIVER_FIXTURE_TOOLS.map((tool) => ({
  ...tool,
  *program(input: Parameters<typeof tool.program>[0], context: Parameters<typeof tool.program>[1]) {
    yield* ExecutionServices.api.operations.ready();
    return yield* tool.program(input, context);
  },
}));
