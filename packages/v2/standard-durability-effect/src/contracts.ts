import type { Effect, Scope } from "effect";

/** Opaque requirement supplied by effectProgram; consumers do not construct bindings. */
export interface CompositionScope {
  readonly "~standard-durability/composition": unique symbol;
}

/** Native effects used by portable composition operations. */
export type EffectYield = Effect.Effect<unknown, never, CompositionScope | Scope.Scope>;
