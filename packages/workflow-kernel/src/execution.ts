import type { Operation } from "effection";
import {
  createExecution,
  assertJson,
  definePort,
  type ExecutionDriver,
  type Json,
} from "@sweatpants/foundation";
import type {
  WorkflowExecutionState,
  WorkflowBoundary,
  ExchangeReply,
  ExchangeRequest,
  KernelSnapshot,
  WorkflowKernel,
} from "./index.ts";

/** Evaluators supply mechanics; the shared execution state machine owns command discipline. */
export function createKernelExecution(
  boundary: WorkflowBoundary,
  driver: ExecutionDriver<ExchangeRequest, ExchangeReply, Json, Json> & {
    capture(): Operation<KernelSnapshot>;
  },
): WorkflowExecutionState {
  const executionState = createExecution(boundary, driver);
  return {
    boundary: executionState.boundary,
    execution: Object.assign(executionState.execution, {
      capture: () =>
        executionState.observe(function* () {
          const snapshot = yield* driver.capture();
          assertJson(snapshot);
          return snapshot;
        }),
    }),
  };
}

/** Both fresh and recovered startups return the same snapshot-capable live handle. */
export const KernelExecutor = definePort<Pick<WorkflowKernel, "start">>("kernel-executor", {
  *start() {
    throw new Error("No kernel executor is installed in this scope");
  },
});
