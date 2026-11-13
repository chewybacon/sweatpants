import type { Operation } from "@standard-durability/core";
import type { AttemptProducer, Runtime, RuntimeExecution, Session } from "./contracts.ts";

/** Acquire a session in the executing scope. Each send starts one fresh producer
 * through runtime.start; the acquisition scope stops and joins all outstanding
 * executions on exit. Send/subscription/waiter scopes do not own those executions.
 * Does not capture native execution context, acknowledge durable acceptance, clone
 * values or map failures into public events; those remain producer responsibilities.
 * Native shutdown does not record durable workflow cancellation. */
export function* createSession<Input, Event, End, Y>(
  runtime: Runtime<Y>,
  createAttempt: (input: Input) => AttemptProducer<Event, End, Y>,
): Operation<Session<Input, Event, End, Y>, Y> {
  let active = true;
  const running = new Set<RuntimeExecution<End>>();
  yield* runtime.composition.ensure(function* () {
    active = false;
    // Initiate every cancellation before joining: sibling cleanups may depend
    // on one another having begun shutdown.
    yield* runtime.fromPromise(async () => {
      await Promise.all([...running].map((owner) => owner.cancel()));
    });
    running.clear();
  });
  return {
    *send(input) {
      if (!active) {
        throw new Error("Session scope exited");
      }
      const producer = createAttempt(input);
      const owner = runtime.start(() => producer.run());
      running.add(owner);
      // Observe rejections even when the host only consumes public events. The
      // original result remains available through the attempt's result operation.
      void owner.result.then(
        () => running.delete(owner),
        () => running.delete(owner),
      );
      return {
        events: (offset) => producer.events(offset),
        *result() {
          return yield* runtime.fromPromise(() => owner.result);
        },
      };
    },
  };
}
