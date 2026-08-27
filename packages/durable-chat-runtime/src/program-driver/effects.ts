import { createContext, type Operation } from "effection";
import type { DurableEffectRegistration } from "@sweatpants/chat-core";

/** Scoped ephemeral-effect registrations supplied by a concrete runtime adapter. */
export const ProgramDriverEphemeralEffectsContext = createContext<
  readonly [DurableEffectRegistration, DurableEffectRegistration] | undefined
>("ProgramDriverEphemeralEffects");

/** Resolves optional sampling-aware ephemeral registrations from application setup. */
export function* useOptionalProgramDriverEphemeralEffects(): Operation<
  readonly [DurableEffectRegistration, DurableEffectRegistration] | undefined
> {
  return yield* ProgramDriverEphemeralEffectsContext.get();
}
