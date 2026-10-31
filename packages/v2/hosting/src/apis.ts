import type { Api, Composition } from "@standard-durability/core";
import type { AttemptNotifications, ChildRunner } from "./contracts.ts";

/** Optional bound runner facade; pass operations.run to existing all/race installation. */
export function createChildRunner<C, I, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ChildRunner<C, I, Y>,
): Api<ChildRunner<C, I, Y>, Y> {
  return composition.createApi<ChildRunner<C, I, Y>>(name, driver);
}
/** Scoped notification transport selection. Signals retain their original delivery scope/driver. */
export function createAttemptNotifications<Y>(
  composition: Composition<Y>,
  name: string,
  driver: AttemptNotifications<Y>,
): Api<AttemptNotifications<Y>, Y> {
  return composition.createApi<AttemptNotifications<Y>>(name, driver);
}
