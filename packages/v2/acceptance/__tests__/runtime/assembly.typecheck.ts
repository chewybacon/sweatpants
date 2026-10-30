// Compile-time acceptance of the stack boundary; never executed as a test module.
import type { Effect } from "effect";
import type { Operation as EffectionOperation } from "effection";
import type { Computation, Operation, Outcome, Runtime } from "@sweatpan.ts/runtime";
import type { EffectRuntime, EffectYield } from "@sweatpan.ts/runtime-effect";
import type { EffectionRuntime, EffectionYield } from "@sweatpan.ts/runtime-effection";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
interface Credentials {
  readonly token: string;
}
interface Failure {
  readonly code: "denied";
}

export type EffectMapping = Assert<
  Equal<
    Computation<EffectRuntime, number, Failure, Credentials>,
    Effect.Effect<number, Failure, Credentials>
  >
>;
export type EffectionMapping = Assert<
  Equal<Computation<EffectionRuntime, number, Failure, Credentials>, EffectionOperation<number>>
>;
export type PortableFailure = Assert<
  Equal<
    Computation<EffectionRuntime, Outcome<number, Failure>>,
    EffectionOperation<Outcome<number, Failure>>
  >
>;

export function rejectInvalidAssembly(
  effect: Runtime<EffectYield>,
  effection: Runtime<EffectionYield>,
  effectWork: Operation<number, EffectYield>,
  effectionWork: Operation<number, EffectionYield>,
  required: Computation<EffectRuntime, number, never, Credentials>,
  outcome: Outcome<number, Failure>,
) {
  // @ts-expect-error A native protocol must not cross into the other runner.
  effect.start(() => effectionWork);
  // @ts-expect-error A native protocol must not cross into the other runner.
  effection.start(() => effectWork);
  // @ts-expect-error Native service requirements cannot disappear at the host boundary.
  effect.start(() => required);
  // @ts-expect-error Outcomes must be narrowed before accessing their successful value.
  const result: number = outcome.value;
  return result;
}
