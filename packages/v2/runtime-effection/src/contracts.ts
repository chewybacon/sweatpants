import type { Operation } from "effection";
import type { RuntimeType } from "@standard-durability/core";
export type { EffectionYield } from "@standard-durability/effection";

/** Effection tracks the result; errors and service requirements remain runtime concerns. */
export interface EffectionRuntime extends RuntimeType {
  readonly type: Operation<this["Target"]>;
}
