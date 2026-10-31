import type { Api, Operation } from "@standard-durability/core";
import type { AttemptControl } from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Hosting, AttemptNotifications } from "./contracts.ts";
import { createAttemptNotifications } from "./apis.ts";

/**
 * Install optional prompt interruption around handler delivery. Subscribe then inspect
 * closes the grant/subscription race; settle remains the authoritative atomic guard.
 * Missed notifications can delay physical shutdown but cannot authorize late outcomes.
 * Publication failure can surface after durable invalidation; repeating the command is safe.
 * Returns the exact facade used by cancellation. Raw transports are bound once per installation;
 * supplied APIs retain identity. Install policy on this facade in the surrounding scope.
 * This does not implement durable scope cancellation or logical compensation.
 */
export function* installAttemptCancellation<R, Q, V, E, Y>(
  runtime: Runtime<Y>,
  hosting: Hosting<R, Q, V, E, Y>,
  control: AttemptControl<Q, V, E, Y>,
  transport: AttemptNotifications<Y> | Api<AttemptNotifications<Y>, Y>,
): Operation<Api<AttemptNotifications<Y>, Y>, Y> {
  const notifications =
    "operations" in transport
      ? transport
      : createAttemptNotifications(runtime.composition, "attempt-notifications", transport);
  yield* hosting.around({
    handle(args, next) {
      return runtime.composition.scoped(function* () {
        const grant = yield* hosting.delivery.expect();
        const signal = yield* notifications.operations.subscribe(grant);
        const state = yield* control.inspect(grant);
        if (state.state !== "active") {
          throw new Error("Attempt is no longer active");
        }
        return yield* runtime.withSignal(signal, () => next(...args));
      });
    },
    *cancel(args, next) {
      const result = yield* next(...args);
      if (result.attempt) {
        yield* notifications.operations.publish(result.attempt);
      }
      return result;
    },
    *invalidateAttempt(args, next) {
      const result = yield* next(...args);
      if (result.state === "invalidated") {
        yield* notifications.operations.publish(args[0]);
      }
      return result;
    },
  });
  return notifications;
}
