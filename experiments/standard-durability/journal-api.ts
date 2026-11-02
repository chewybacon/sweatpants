import { assertJson, type Json } from "@sweatpants/foundation";
import type { Dispatcher, Handler, Outcome } from "@sweatpants/standard-durability";

/** This journal records the domain answer as a JSON exchange value. */
export type JournalHandler<Request, Y> = Handler<Request, Y, Outcome<Json, never>>;

/** Adapt domain dispatch to this journal's exchange convention. No acceptance happens here. */
export function journalHandler<Request, Y>(
  binding: Dispatcher<Request, Y, Outcome<unknown, unknown>>,
): JournalHandler<Request, Y> {
  return function* (request) {
    const outcome = yield* binding.dispatch(request);
    return { ok: true, value: assertJson(outcome) };
  };
}
