import type { Api, Composition } from "@standard-durability/core";
import { activateJournal, JournalConflict, type AttemptGrant } from "@sweatpan.ts/durable";
import type { Hosting, HostingMethods, HostingOptions } from "./contracts.ts";

/**
 * Build scoped dispatch: activate with selected Guest lifetime, then register a participant wait or
 * commit an execution grant, handle, accept and reactivate.
 * Only accepted Outcomes advance the computation. Middleware composes the returned
 * API; delivery identity is available through its context rather than handler arguments.
 *
 * @remarks Native runtime cancellation stops physical work, not the durable workflow.
 * Stale pre-delivery observations reactivate; handler and settlement failures escape.
 * The journal and attempts capabilities must belong to the same execution.
 */
export function createHosting<R, Q, V, E, S, Y>(
  composition: Composition<Y>,
  options: HostingOptions<R, Q, V, E, S, Y>,
): Hosting<R, Q, V, E, Y> {
  const delivery = composition.createContext<AttemptGrant>(`${options.name}:delivery`);
  const api: Api<HostingMethods<R, Q, V, E, Y>, Y> = composition.createApi<
    HostingMethods<R, Q, V, E, Y>
  >(options.name, {
    run(replace) {
      return composition.scoped(function* () {
        let expected = replace;
        while (true) {
          function* conflict(error: unknown) {
            if (!(error instanceof JournalConflict) || expected) {
              throw error;
            }
            return undefined;
          }
          const observed = yield* composition.catchError(function* () {
            const activation = yield* api.operations.activate();
            const child =
              activation.state === "parked"
                ? yield* api.operations.child(activation.pending)
                : undefined;
            return { activation, child };
          }, conflict);
          if (!observed) {
            continue;
          }
          const { activation, child } = observed;
          if (activation.state !== "parked") {
            return activation;
          }
          // Child hosts own their retries; delivery failures must escape this host too.
          if (child) {
            if (expected) {
              throw new Error("Cannot replace an effect attempt with an owned call");
            }
            if (!(yield* child.run())) {
              return { state: "child", childId: child.id };
            }
            continue;
          }
          const mode = yield* api.operations.deliveryMode(activation.pending.request);
          if (mode === "wait") {
            if (expected) {
              throw new Error("Cannot replace an effect attempt with a participant wait");
            }
            const interactions = options.interactions;
            if (!interactions) {
              throw new Error("Participant interaction capability is not installed");
            }
            const registration = yield* composition.catchError(
              () => interactions.register(activation.pending.id),
              conflict,
            );
            if (!registration) {
              continue;
            }
            return { ...registration, pending: activation.pending };
          }
          const safety = yield* api.operations.retrySafety(activation.pending.request);
          const started = yield* composition.catchError(
            () => options.attempts.begin(activation.pending.id, safety, expected),
            conflict,
          );
          if (!started) {
            continue;
          }
          if (started.state !== "granted") {
            return started;
          }
          const request = activation.pending.request;
          const grant = started.grant;
          expected = undefined;
          yield* composition.scoped(function* () {
            yield* delivery.set(grant);
            const outcome = yield* api.operations.handle(request);
            yield* options.attempts.settle(grant, outcome);
          });
        }
      });
    },
    activate() {
      return activateJournal(composition, options.recovery, options.journal);
    },
    *child() {
      return undefined;
    },
    *cancel(requestId, reason) {
      if (!options.journal.cancellation) {
        throw new Error("Journal does not support root cancellation");
      }
      return yield* options.journal.cancellation.request(requestId, reason);
    },
    *deliveryMode() {
      return "execute";
    },
    *answer(grant, outcome) {
      if (!options.interactions) {
        throw new Error("Participant interaction capability is not installed");
      }
      return yield* options.interactions.answer(grant, outcome);
    },
    *invalidate(grant, reason) {
      if (!options.interactions) {
        throw new Error("Participant interaction capability is not installed");
      }
      return yield* options.interactions.invalidate(grant, reason);
    },
    *invalidateAttempt(grant, reason) {
      if (!options.attemptControl) {
        throw new Error("Attempt control capability is not installed");
      }
      return yield* options.attemptControl.invalidate(grant, reason);
    },
    handle: options.handle,
    *retrySafety() {
      return "unsafe";
    },
  });
  return { ...api, delivery };
}
