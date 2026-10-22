import { composeWorkflowExecution } from "@sweatpants/flowmode-runtime";
import type { Operation } from "effection";
import type {
  WorkflowBoundary,
  KernelSnapshot,
  ExchangeReply,
  WorkflowExecutionState,
  WorkflowInspection,
  WorkflowRuntimeOptions,
} from "@sweatpants/flowmode-runtime";

type TraceData = {
  boundary?: WorkflowBoundary;
  inspection?: WorkflowInspection;
  durationMs?: number;
  snapshot?: KernelSnapshot;
  reply?: ExchangeReply;
  bytes?: number;
};

/** App trace presentation uses the same operation middleware for both evaluators.
 * Failures propagate, as with other middleware; no diagnostic error is silently swallowed.
 */
export function executionDiagnostics(
  record: (kind: string, data?: TraceData) => void,
): Pick<WorkflowRuntimeOptions, "kernelMiddleware"> {
  function* inspect(state: WorkflowExecutionState) {
    if (state.execution.inspect) {
      return yield* state.execution.inspect();
    }
    return undefined;
  }
  function decorate(state: WorkflowExecutionState): WorkflowExecutionState {
    const execution = state.execution;
    function* transition(kind: string, next: () => Operation<WorkflowBoundary>) {
      const started = performance.now();
      const boundary = yield* next();
      const inspection = yield* inspect(state);
      record(kind, {
        boundary,
        durationMs: performance.now() - started,
        // CONDITIONAL-SPREAD: Unsupported inspection stays absent in portable trace data.
        ...(inspection ? { inspection } : {}),
      });
      return boundary;
    }
    return {
      boundary: state.boundary,
      execution: composeWorkflowExecution({
        driver: execution,
        middleware: [
          {
            *resume(args, next) {
              record("reply", { reply: args[1] });
              return yield* transition("resume", () => next(...args));
            },
            *cancel(args, next) {
              return yield* transition("cancel", () => next(...args));
            },
            *capture(args, next) {
              const snapshot = yield* next(...args);
              const state =
                typeof snapshot.state === "string"
                  ? snapshot.state
                  : JSON.stringify(snapshot.state);
              record("capture", { bytes: new TextEncoder().encode(state).length });
              return snapshot;
            },
            *dispose(args, next) {
              yield* next(...args);
              record("dispose");
            },
          },
        ],
      }),
    };
  }
  function* startup(kind: string, next: () => Operation<WorkflowExecutionState>) {
    const started = performance.now();
    const state = yield* next();
    const inspection = yield* inspect(state);
    record(kind, {
      boundary: state.boundary,
      durationMs: performance.now() - started,
      // CONDITIONAL-SPREAD: Unsupported inspection stays absent in portable trace data.
      ...(inspection ? { inspection } : {}),
    });
    return decorate(state);
  }
  return {
    kernelMiddleware: [
      {
        *start(args, next) {
          return yield* startup("start", () => next(...args));
        },
        *restore(args, next) {
          record("checkpoint-selected", { snapshot: args[1] });
          return yield* startup("restore", () => next(...args));
        },
      },
    ],
  };
}
