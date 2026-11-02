// Source and production declaration checks; these functions are never executed.
import type {
  Api,
  Composition,
  Operation,
  OperationMiddleware,
  Operations,
  Outcome,
} from "@standard-durability/core";
import { type Guest, type GuestWork, type Turn } from "@sweatpan.ts/execution";
import type { EffectYield } from "@sweatpan.ts/runtime-effect";
import type { EffectionYield } from "@sweatpan.ts/runtime-effection";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Result = { text: string; length: number };
type Request = { id: string };
type ReaderGuest<Y> = Guest<Result, Request, Y, string, "missing">;
export type NoDoubleWrapping = Assert<
  Equal<
    Api<ReaderGuest<EffectYield>, EffectYield>["operations"]["start"],
    () => Operation<Turn<Result, Request>, EffectYield>
  >
>;
export type ExactResume = Assert<
  Equal<
    Parameters<NonNullable<OperationMiddleware<ReaderGuest<EffectYield>>["resume"]>>[0],
    [outcome: Outcome<string, "missing">]
  >
>;

export function rejectInvalidComposition<Y>(
  composition: Composition<Y>,
  guest: ReaderGuest<Y>,
  acquire: GuestWork<Result, Request, Y, string, "missing">,
) {
  const api = composition.createApi("typed-guest", guest);
  const acquisition = composition.createApi("typed-acquisition", { acquire });
  const result: Operation<ReaderGuest<Y>, Y> = acquisition.operations.acquire();
  // @ts-expect-error Resume retains the concrete successful reply type.
  api.operations.resume({ ok: true, value: 123 });
  // @ts-expect-error Resume retains the concrete failure type.
  api.operations.resume({ ok: false, error: "other" });
  api.around({
    // @ts-expect-error Middleware must return a Turn, not a plain result.
    *start() {
      return { text: "wrong", length: 5 };
    },
  });
  const legacy = composition.createApi<{ read(): string }>("value-shorthand", {
    *read() {
      return "text";
    },
  });
  const read: Operations<{ read(): string }, Y> = legacy.operations;
  return { result, read };
}

export function rejectWrongRuntime(
  composition: Composition<EffectYield>,
  foreign: ReaderGuest<EffectionYield>,
) {
  // @ts-expect-error Operation-bearing APIs cannot install the other runtime's protocol.
  composition.createApi("foreign", foreign);
}

// Generic call signatures remain intact at the facade. This does not claim that
// automatically extracted middleware preserves their per-call relationship.
interface Generic<Y> {
  echo<T>(value: T): Operation<T, Y>;
}
export type GenericFacade = Assert<
  Equal<Api<Generic<EffectYield>, EffectYield>["operations"], Generic<EffectYield>>
>;
