import type { All } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { OwnedAll } from "./contracts.ts";
import { createOwnedGroup } from "./owned-group.ts";

/** Assemble ordered inline all over owned journals; the host supplies child execution. */
export function createOwnedAll<C, I, Y>(runtime: Runtime<Y>, name: string): OwnedAll<C, I, Y> {
  const group = createOwnedGroup<C, I, Y>(runtime, name, "all");
  return {
    effect: group.effect,
    install: group.install,
    *acquire() {
      // The all join preserves declaration order and one result per branch.
      return (yield* group.acquire()) as All<C, I>;
    },
  };
}
