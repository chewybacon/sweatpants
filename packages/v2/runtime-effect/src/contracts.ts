import type { Effect } from "effect";
import type { RuntimeType } from "@standard-durability/core";
export type { EffectYield } from "@standard-durability/effect";

/** Preserve native Effect result, error and service requirements. */
export interface EffectRuntime extends RuntimeType {
  readonly type: Effect.Effect<this["Target"], this["Out1"], this["Out2"]>;
}
