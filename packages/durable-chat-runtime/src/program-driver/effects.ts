import { createContext, type Operation } from "effection";
import type { DurableEffectRegistration } from "@sweatpants/chat-core";

/** Scoped foreign-effect registrations supplied by a concrete runtime adapter. */
export const ProgramDriverForeignEffectsContext = createContext<
  readonly [DurableEffectRegistration, DurableEffectRegistration] | undefined
>("ProgramDriverForeignEffects");

/** Resolves optional sampling-aware foreign registrations from application setup. */
export function* useOptionalProgramDriverForeignEffects(): Operation<
  readonly [DurableEffectRegistration, DurableEffectRegistration] | undefined
> {
  return yield* ProgramDriverForeignEffectsContext.get();
}
