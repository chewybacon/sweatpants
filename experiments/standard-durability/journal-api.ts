import { assertJson, type Json } from "@sweatpants/foundation";
import type { Operation, Outcome } from "@sweatpants/standard-durability";

/** Adapt domain dispatch to this journal's exchange convention. No acceptance happens here. */
export function journalHandler<Request, Y>(binding: {
  dispatch(request: Request): Operation<Outcome<unknown, unknown>, Y>;
}): (request: Request) => Operation<Outcome<Json, never>, Y> {
  return function* (request) {
    const outcome = yield* binding.dispatch(request);
    return { ok: true, value: assertJson(outcome) };
  };
}
