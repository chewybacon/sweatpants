import type { WorkflowRuntimeOptions } from "@sweatpants/flowmode-runtime";

/** Experiment-owned trace recording through the public runtime middleware contract. */
export function lifecycleEvents(
  events: string[],
): Pick<WorkflowRuntimeOptions, "kernelMiddleware" | "executionMiddleware"> {
  return {
    kernelMiddleware: [
      {
        *start(args, next) {
          const state = yield* next(...args);
          events.push("start");
          return state;
        },
        *restore(args, next) {
          events.push("checkpoint-selected");
          const state = yield* next(...args);
          events.push("restore");
          return state;
        },
      },
    ],
    executionMiddleware: [
      {
        *resume(args, next) {
          events.push("reply");
          const boundary = yield* next(...args);
          events.push("resume");
          return boundary;
        },
        *cancel(args, next) {
          const boundary = yield* next(...args);
          events.push("cancel");
          return boundary;
        },
        *capture(args, next) {
          const snapshot = yield* next(...args);
          events.push("capture");
          return snapshot;
        },
        *dispose(args, next) {
          yield* next(...args);
          events.push("dispose");
        },
      },
    ],
  };
}
