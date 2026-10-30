import type { Composition } from "@standard-durability/core";
import type { StreamApi, StreamMethods } from "./contracts.ts";

/**
 * Expose an ordinary scoped subscription API as a Stream. Context selection belongs
 * to the supplied driver; install and around retain normal composition semantics.
 * Middleware may wrap next on the returned subscription to intercept events.
 * Acquisition lifetime is unchanged: middleware-created child scopes cannot return
 * a subscription for use after that child exits.
 */
export function createStreamApi<T, Close, Y>(
  composition: Composition<Y>,
  name: string,
  defaults: StreamMethods<T, Close, Y>,
): StreamApi<T, Close, Y> {
  const api = composition.createApi<StreamMethods<T, Close, Y>>(name, defaults);
  return {
    ...api,
    stream: {
      *[Symbol.iterator]() {
        return yield* api.operations.subscribe();
      },
    },
  };
}
