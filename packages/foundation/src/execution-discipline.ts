import type { IterableOperation as Operation, Work } from "./computation.ts";

/** One lifecycle guard for cursors and correlated executions, independent of their protocol. */
export function createExecutionDiscipline<Boundary, Y>(initial: Boundary) {
  let boundary = initial;
  let state: "ready" | "advancing" | "capturing" | "unknown" | "closed" = "ready";
  let disposal: "pending" | "running" | "done" = "pending";

  function assertReady() {
    if (state === "closed") {
      throw new Error("execution_closed");
    }
    if (state === "unknown") {
      throw new Error("execution_outcome_unknown");
    }
    if (state === "advancing" || state === "capturing") {
      throw new Error("execution_command_in_progress");
    }
  }

  return {
    current() {
      assertReady();
      return boundary;
    },
    *advance<Next extends Boundary>(work: Work<Next, Y>): Operation<Next, Y> {
      assertReady();
      state = "advancing";
      let received = false;
      try {
        const next = yield* work();
        boundary = next;
        received = true;
        return next;
      } finally {
        state = received ? "ready" : "unknown";
      }
    },
    *capture<T>(read: Work<T, Y>): Operation<T, Y> {
      assertReady();
      state = "capturing";
      try {
        return yield* read();
      } finally {
        state = "ready";
      }
    },
    *dispose(release: Work<void, Y>): Operation<void, Y> {
      if (disposal === "done") {
        return;
      }
      if (disposal === "running" || state === "advancing" || state === "capturing") {
        throw new Error("execution_command_in_progress");
      }
      state = "closed";
      disposal = "running";
      let released = false;
      try {
        yield* release();
        released = true;
      } finally {
        disposal = released ? "done" : "pending";
      }
    },
  };
}
