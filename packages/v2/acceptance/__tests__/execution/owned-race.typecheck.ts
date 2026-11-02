import type { Operation, Outcome } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import { createOwnedRace } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

interface Context {
  ask(): Operation<Outcome<boolean, { code: "declined" }>, CapabilityRequest>;
}

/** Consumer checked against both source and emitted declarations. */
export function* ownedRaceAuthoring<Y>(runtime: Runtime<Y>) {
  const owned = createOwnedRace<Context, CapabilityRequest, Y>(runtime, "typed-race");
  const race = yield* owned.acquire();
  const result = race(
    function* (branch) {
      return yield* branch.ask();
    },
    function* () {
      return 42;
    },
  );
  const inferred: Operation<Outcome<boolean, { code: "declined" }> | number, CapabilityRequest> =
    result;
  // @ts-expect-error A race returns one branch result, not an ordered tuple.
  const tuple: Operation<[Outcome<boolean, { code: "declined" }>, number], CapabilityRequest> =
    result;
  // @ts-expect-error There is no winner for an empty race.
  race();
  // @ts-expect-error Native Promise factories are not controlled Guest instructions.
  race(async () => 1);
  race(function* (branch) {
    // @ts-expect-error Branch context only exposes granted capabilities.
    yield* branch.missing();
  });
  return { inferred, tuple };
}
