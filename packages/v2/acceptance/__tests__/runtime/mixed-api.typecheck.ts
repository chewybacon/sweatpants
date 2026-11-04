import type { Composition, Operation } from "@standard-durability/core";
import type { EffectYield } from "@sweatpan.ts/runtime-effect";
import type { EffectionYield } from "@sweatpan.ts/runtime-effection";

export function* mixedTypes<Y>(composition: Composition<Y>) {
  const api = composition.createApi("mixed-types", {
    sync: {
      name: "example",
      count: 1,
      empty: null,
      missing: undefined,
      array: () => [1, 2],
      bytes: () => new Uint8Array(2),
      echo<T>(value: T): T {
        return value;
      },
      transaction<T>(work: () => T): T {
        return work();
      },
      fail(): never {
        throw new Error("default");
      },
    },
    operations: {
      *read(): Operation<string, Y> {
        return "value";
      },
    },
  });
  const read: Operation<string, Y> = api.operations.read();
  const access = yield* api;
  const literal: "literal" = access.echo("literal" as const);
  const name: string = access.name;
  // @ts-expect-error Operations are not synchronous members.
  access.read();
  // @ts-expect-error Synchronous members are not lifted onto operations.
  api.operations.array();
  // @ts-expect-error Acquired properties are read-only.
  access.count = 3;
  api.around({
    sync: {
      // @ts-expect-error Preserve the generic relationship.
      echo: () => () => 123,
      // @ts-expect-error Preserve transaction callback/result relationship.
      transaction: () => () => "wrong",
      // @ts-expect-error Property decorators preserve value type.
      name: () => () => 42,
      // @ts-expect-error Ordinary methods cannot return operations.
      array: () =>
        function* () {
          return [1];
        },
    },
  });
  composition.createApi("promise", {
    sync: {
      // @ts-expect-error Promises need an explicit runtime adapter.
      read: async () => 3,
    },
  });
  composition.createApi("promise-union", {
    sync: {
      // @ts-expect-error A union containing a Promise is also unsupported.
      read: (): number | Promise<number> => 3,
    },
  });
  return { read, literal, name };
}

export function rejectMixedForeignRuntime(
  composition: Composition<EffectYield>,
  foreign: () => Operation<string, EffectionYield>,
) {
  composition.createApi("foreign-mixed", {
    // @ts-expect-error Adding synchronous members cannot bypass runtime compatibility.
    operations: { foreign },
    sync: { label: "test" },
  });
}
