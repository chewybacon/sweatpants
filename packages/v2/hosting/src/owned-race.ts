import type { Branch, Race } from "@sweatpan.ts/core";
import type { Runtime } from "@sweatpan.ts/runtime";
import type { OwnedRace } from "./contracts.ts";
import { createOwnedGroup } from "./owned-group.ts";

/**
 * First terminal child completion wins durably. Eligible losers are fenced in that
 * transaction and their logical cleanup must drain before the parent receives the
 * winner. Protected scopes retain authority until safe. Empty races reject.
 */
export function createOwnedRace<C, I, Y>(runtime: Runtime<Y>, name: string): OwnedRace<C, I, Y> {
  const group = createOwnedGroup<C, I, Y>(runtime, name, "race");
  return {
    effect: group.effect,
    install: group.install,
    *acquire() {
      const invoke = yield* group.acquire();
      const race: Race<C, I> = function* <
        const B extends readonly [Branch<C, I>, ...Branch<C, I>[]],
      >(...branches: B) {
        if (!branches.length) {
          throw new Error("Owned race must not be empty");
        }
        // Group storage supplies a singleton containing its atomically pinned winner.
        const values = yield* invoke(...branches);
        return values[0] as B[number] extends Branch<C, I, infer R> ? R : never;
      };
      return race;
    },
  };
}
