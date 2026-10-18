import type { Operation } from "effection";
import {
  createExecution,
  definePort,
  type ExecutionDriver,
  type Json,
} from "@sweatpants/foundation";
import type {
  KernelExecutionState,
  KernelBoundary,
  KernelReply,
  KernelRequest,
  KernelSnapshot,
  WorkflowKernel,
} from "./index.ts";

/** Evaluators supply mechanics; the shared execution state machine owns command discipline. */
export function createKernelExecution(
  boundary: KernelBoundary,
  driver: ExecutionDriver<KernelRequest, KernelReply, Json, Json> & {
    capture(): Operation<KernelSnapshot>;
  },
): KernelExecutionState {
  const executionState = createExecution(boundary, driver);
  return {
    boundary: executionState.boundary,
    execution: Object.assign(executionState.execution, { capture: () => driver.capture() }),
  };
}

/** Both fresh and recovered startups return the same snapshot-capable live handle. */
export const KernelExecutor = definePort<Pick<WorkflowKernel, "start">>("kernel-executor", {
  *start() {
    throw new Error("No kernel executor is installed in this scope");
  },
});
