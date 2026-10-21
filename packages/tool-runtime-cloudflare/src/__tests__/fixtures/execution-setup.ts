import { definePort } from "@sweatpants/foundation/port";
import { CrankError } from "@sweatpants/durable-execution";
import { DURABLE_DRIVER_FIXTURE_TOOLS } from "@sweatpants/journal-authority/testing";
import type { Operation } from "effection";

const ExecutionServices = definePort<{ ready(): Operation<void> }>("executor-test-services", {
  *ready() {
    throw new CrankError("execution_setup_missing", "Setup did not run in the execution scope");
  },
});

export function* installExecutionServices() {
  yield* ExecutionServices.installDriver({ *ready() {} });
}

// Retain the conformance tools' real programs and outputs. Every existing replay,
// cancellation, and cleanup scenario requires services in both program and record scopes.
export const toolsWithExecutionServices = DURABLE_DRIVER_FIXTURE_TOOLS.map((tool) => ({
  ...tool,
  *program(input: Parameters<typeof tool.program>[0], context: Parameters<typeof tool.program>[1]) {
    yield* ExecutionServices.api.operations.ready();
    yield* context.record(
      { key: "execution-service-check", retrySafety: { mode: "repeatable" } },
      function* () {
        yield* ExecutionServices.api.operations.ready();
        return null;
      },
    );
    return yield* tool.program(input, context);
  },
}));
