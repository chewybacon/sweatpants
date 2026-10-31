import type { Operation } from "@standard-durability/core";
import type { Runtime, RuntimeExecution } from "@sweatpan.ts/runtime";
import type { ActivationDriver, ActivationWork } from "./contracts.ts";

/**
 * Acquire a driver owned by the current scope. Acquire in a request for request-bound
 * work, or in an application supervisor for work independent of request lifetimes.
 * Owner exit rejects further starts and cancels/joins every remaining execution.
 * Native roots do not inherit caller bindings: configure capabilities inside work.run.
 * No output buffer, durable cancellation, scheduling, lease or retry is introduced.
 */
export function* createOwnedActivationDriver<Result, Y>(
  runtime: Runtime<Y>,
  work: ActivationWork<Result, Y>,
): Operation<ActivationDriver<Result, Y>, Y> {
  const active = new Set<RuntimeExecution<Result>>();
  let closed = false;
  yield* runtime.composition.ensure(function* () {
    closed = true;
    yield* runtime.fromPromise(() => Promise.all([...active].map((task) => task.cancel())));
  });
  return {
    *start() {
      if (closed) {
        throw new Error("Activation owner has closed");
      }
      const task = runtime.start(() => work.run());
      active.add(task);
      // Observe failures without changing the result promise exposed to callers.
      void task.result.then(
        () => {
          active.delete(task);
        },
        () => {
          active.delete(task);
        },
      );
      return task;
    },
  };
}
