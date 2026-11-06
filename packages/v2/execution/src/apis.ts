import type { Api, Composition } from "@standard-durability/core";
import type { ProgramResolver, Kernel, PreparedProgram } from "./contracts.ts";

/** Scoped artifact/placement selection. Keep live Guests out of resolver caches. */
export function createProgramResolver<I, P, Y>(
  composition: Composition<Y>,
  name: string,
  driver: ProgramResolver<I, P, Y>,
): Api<ProgramResolver<I, P, Y>, Y> {
  return composition.createApi<ProgramResolver<I, P, Y>>(name, driver);
}

/** Scoped evaluator preparation policy. The driver owns compatibility checks; middleware
 * is trusted. This facade owns no live Guest and adds no execution/recovery loop. */
export function createKernel<P, I, B extends PreparedProgram<unknown, unknown, unknown>, Y>(
  composition: Composition<Y>,
  name: string,
  driver: Kernel<P, I, B, NoInfer<Y>>,
): Api<Kernel<P, I, B, Y>, Y> {
  return composition.createApi<Kernel<P, I, B, Y>>(name, driver);
}
