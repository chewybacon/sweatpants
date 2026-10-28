import type { Api, Composition } from "@standard-durability/core";
import { activateJournal, type AttemptGrant } from "@sweatpan.ts/durable";
import type { Hosting, HostingMethods, HostingOptions } from "./contracts.ts";

/**
 * Build scoped dispatch: activate/dispose, then register a participant wait or
 * commit an execution grant, handle, accept and reactivate.
 * Only accepted Outcomes advance the computation. Middleware composes the returned
 * API; delivery identity is available through its context rather than handler arguments.
 *
 * @remarks Native runtime cancellation stops physical work, not the durable workflow.
 * Concurrent activation can reject with a revision conflict before grant acquisition.
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
          const activation = yield* activateJournal(composition, options.recovery, options.journal);
          if (activation.state !== "parked") {
            return activation;
          }
          const child = yield* api.operations.child(activation.pending);
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
            if (!options.interactions) {
              throw new Error("Participant interaction capability is not installed");
            }
            const registration = yield* options.interactions.register(activation.pending.id);
            return { ...registration, pending: activation.pending };
          }
          const safety = yield* api.operations.retrySafety(activation.pending.request);
          const started = yield* options.attempts.begin(activation.pending.id, safety, expected);
          if (started.state !== "granted") {
            return started;
          }
          expected = undefined;
          yield* composition.scoped(function* () {
            yield* delivery.set(started.grant);
            const outcome = yield* api.operations.handle(activation.pending.request);
            yield* options.attempts.settle(started.grant, outcome);
          });
        }
      });
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
