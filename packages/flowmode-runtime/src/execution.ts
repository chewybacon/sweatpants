import type { WorkflowInspection } from "./inspection.ts";
import type { Operation } from "effection";
import {
  createCheckpointExecution,
  composeOperation,
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
    Checkpointing<KernelSnapshot> {
  inspect?(): Operation<WorkflowInspection>;
}

export interface WorkflowExecutionOptions extends OperationOptions<
  WorkflowExecutionDriver,
  Required<WorkflowExecution>
> {
  readonly initial: WorkflowBoundary;
}

/** Evaluators supply mechanics; the shared execution state machine owns command discipline. */
export function createKernelExecution({
  initial,
  driver,
  middleware,
}: WorkflowExecutionOptions): WorkflowExecutionState {
  const state = createCheckpointExecution({
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
  return {
    ...state,
    execution: {
      ...state.execution,
      // CONDITIONAL-SPREAD: Absence distinguishes unsupported inspection from failure.
      ...(driver.inspect
        ? {
            inspect: composeOperation(
              function* () {
                const inspection = yield* driver.inspect!();
                return structuredClone(inspection);
              },
              (middleware ?? []).map((m) => m.inspect),
            ),
          }
        : {}),
    },
  };
}

/** Both fresh and recovered startups return the same snapshot-capable live handle. */
export const KernelExecutor = definePort<Pick<WorkflowKernel, "start">>("kernel-executor", {
  *start() {
    throw new Error("No kernel executor is installed in this scope");
  },
});
