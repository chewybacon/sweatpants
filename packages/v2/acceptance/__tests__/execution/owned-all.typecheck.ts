import type { Operation, Outcome } from "@standard-durability/core";
import type { CapabilityRequest } from "@sweatpan.ts/core";
import type { LogicalScope, ScopeInstruction } from "@sweatpan.ts/execution";
import { createOwnedAll } from "@sweatpan.ts/hosting";
import type { Runtime } from "@sweatpan.ts/runtime";

interface Context {
  readonly scope: LogicalScope;
  elicit(question: string): Operation<Outcome<boolean, unknown>, CapabilityRequest>;
  score(topic: string): Operation<Outcome<number, never>, CapabilityRequest>;
}

// Non-executed consumer of production authoring, checked against source and emitted types.
// Named tools use ordinary granted calls inside factories; no phantom child descriptor API.
export function* ownedAllAuthoring<Y>(runtime: Runtime<Y>) {
  const owned = createOwnedAll<Context, CapabilityRequest | ScopeInstruction, Y>(
    runtime,
    "typed-all",
  );
  const all = yield* owned.acquire();
  const tuple = all(
    function* (branch) {
      yield* branch.scope.ensure(function* () {});
      return yield* branch.elicit("Approve?");
    },
    function* (branch) {
      const result = yield* branch.score("research");
      if (!result.ok) {
        throw new Error("Score unavailable");
      }
      return result.value;
    },
  );
  const inferred: Operation<[Outcome<boolean, unknown>, number], CapabilityRequest> = tuple;
  // @ts-expect-error Branch result positions remain distinct.
  const reversed: Operation<[number, Outcome<boolean, unknown>], CapabilityRequest> = tuple;
  const empty: Operation<[], CapabilityRequest> = all();
  const iterator = (function* () {
    return 1;
  })();
  // @ts-expect-error Already-created iterators are not branch factories.
  all(iterator);
  all(function* (branch) {
    // @ts-expect-error Named call retains its caller input type.
    yield* branch.score(123);
    // @ts-expect-error Only branch-granted capabilities appear in its context.
    yield* branch.missing();
  });
  // @ts-expect-error Native Promise operations are not controlled Guest instructions.
  all(async () => 1);
  return { inferred, reversed, empty };
}
