import type { Api, Composition, Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import {
  advanceJournal,
  type AttemptControl,
  type Interactions,
  type Journal,
  type Recovered,
  type RecoveryMethods,
  type Recovery,
} from "@sweatpan.ts/durable";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { Hosting, AttemptNotifications, EffectAnswers, EffectGrant } from "./contracts.ts";
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

/**
 * Install per-run Guest retention in the executing scope. Each run owns a separate
 * continuation and native scope; immediate deliveries reconcile accepted history
 * without reacquiring. Return, failure and cancellation join that scope's cleanup.
 * If scoped middleware closes or hides the driver, the next activation reacquires.
 * Checkpoint/replay middleware still selects initial recovery. This is composable
 * activation policy, not a journal lease or an evaluator-owned record implementation.
 */
export function installGuestRetention<R, Q, V, E, S, Y>(
  composition: Composition<Y>,
  host: Hosting<R, Q, V, E, Y>,
  recovery: Recovery<R, Q, Y, V, E, S>,
  journal: Journal<R, Q, V, E, S, Y>,
): Operation<void, Y> {
  return host.around({
    run(args, next) {
      return composition.scoped(function* () {
        let current: Recovered<R, Q, Y, V, E> | undefined;
        const driver: RecoveryMethods<R, Q, Y, V, E, S> = {
          ...recovery.operations,
          *recover(plan) {
            current =
              current && (yield* recovery.execution.isInstalled(current.guest))
                ? yield* recovery.operations.advance(current, plan)
                : yield* recovery.operations.recover(plan);
            return current;
          },
        };
        yield* host.around({
          *activate() {
            while (true) {
              const activation = yield* advanceJournal(driver, journal);
              if (activation) {
                return activation;
              }
            }
          },
        });
        return yield* next(...args);
      });
    },
  });
}

/**
 * Install raw participant-answer ingress. Resolve the effect from the request stored
 * under the resolution grant, validate/transform its success value, then delegate
 * acceptance. No handler executes and no Guest needs to be acquired. Journal acceptance
 * rechecks authority atomically after validation; replay uses the accepted value.
 * Repeated submissions validate again and compare normalized Outcomes for duplication.
 * The returned raw-answer view is valid only in this installation scope and descendants.
 * Install once on an ingress path; bypass/replacement remains explicit assembly policy.
 */
export function* installEffectAnswers<R, E, Y>(
  host: Hosting<R, CapabilityRequest, unknown, E, Y>,
  effects: Pick<EffectGrant<{}, Y>, "respond">,
  interactions: Pick<Interactions<CapabilityRequest, unknown, E, Y>, "request">,
): Operation<EffectAnswers<E, Y>, Y> {
  yield* host.around({
    *answer([grant, outcome], next) {
      const request = yield* interactions.request(grant);
      const value = yield* effects.respond(request, outcome);
      return yield* next(grant, { ok: true, value });
    },
  });
  // The installed middleware accepts raw authored failures and wraps them in transport
  // success before the driver. Only this scoped ingress view widens the input type.
  return { answer: host.operations.answer as EffectAnswers<E, Y>["answer"] };
}
