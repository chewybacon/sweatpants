import {
  createCheckpointExecution,
  assertJson,
  definePort,
  type ExecutionDriver,
  type Checkpointing,
  type OperationOptions,
  type Json,
} from "@sweatpants/foundation";
import type {
  WorkflowExecutionState,
  WorkflowExecution,
  WorkflowBoundary,
  ExchangeReply,
  ExchangeRequest,
  KernelSnapshot,
  WorkflowKernel,
} from "./index.ts";

/** VM command transports may retain a turn protocol beneath the named execution API. */
export interface WorkflowExecutionDriver
  extends
    ExecutionDriver<ExchangeRequest, ExchangeReply, Json, Json>,
    Checkpointing<KernelSnapshot> {}

export interface WorkflowExecutionOptions extends OperationOptions<
  WorkflowExecutionDriver,
  WorkflowExecution
> {
  readonly initial: WorkflowBoundary;
}

/** Evaluators supply mechanics; the shared execution state machine owns command discipline. */
export function createKernelExecution({
  initial,
  driver,
  middleware,
}: WorkflowExecutionOptions): WorkflowExecutionState {
  return createCheckpointExecution({
    initial,
    middleware,
    validateReply: (request, reply) => driver.validateReply?.(request, reply),
    driver: {
      resume: (suspensionId, reply) => driver.turn({ kind: "resume", suspensionId, reply }),
      cancel: (reason) => driver.turn({ kind: "cancel", reason }),
      dispose: () => driver.dispose(),
      *capture() {
        const snapshot = yield* driver.capture();
        assertJson(snapshot);
        return snapshot;
      },
    },
  });
}

/** Both fresh and recovered startups return the same snapshot-capable live handle. */
export const KernelExecutor = definePort<Pick<WorkflowKernel, "start">>("kernel-executor", {
  *start() {
    throw new Error("No kernel executor is installed in this scope");
  },
});
