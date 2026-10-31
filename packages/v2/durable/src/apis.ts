import type { Api, Composition } from "@standard-durability/core";
import type { Attempts } from "./contracts.ts";

/** Intercept whole journal commands, never transaction internals. Errors after next
 * may follow a committed acceptance and must not trigger external redispatch. */
export function createAttempts<Q, V, E, Y>(
  composition: Composition<Y>,
  name: string,
  driver: Attempts<Q, V, E, Y>,
): Api<Attempts<Q, V, E, Y>, Y> {
  return composition.createApi<Attempts<Q, V, E, Y>>(name, driver);
}
