import type { Api, Composition } from "@standard-durability/core";
import type { ProgramResolver } from "./contracts.ts";

/** Scoped artifact/placement selection. Keep live Guests out of resolver caches. */
export function createProgramResolver<I, P, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ProgramResolver<I, P, Y>,
): Api<ProgramResolver<I, P, Y>, Y> {
  return composition.createApi<ProgramResolver<I, P, Y>>(name, driver);
}
