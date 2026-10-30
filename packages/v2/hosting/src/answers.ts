import type { Operation } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { Interactions } from "@sweatpan.ts/durable";
import type { EffectAnswers, EffectGrant, Hosting } from "./contracts.ts";

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
