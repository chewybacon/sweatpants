import { createContext, ensure, scoped, useScope, type Operation, type Scope } from "effection";
import { createApi } from "effection/experimental";
import type { Api, Composition, Context } from "@standard-durability/core";

import type { EffectionYield } from "./contracts.ts";

/** Reference adapter, using native scopes and middleware rather than a new scheduler. */
export const effection: Composition<EffectionYield> = {
  scoped,
  ensure,
  createContext<T>(name: string): Context<T, EffectionYield> {
    const context = createContext<T>(name);
    return {
      get: () => context.get(),
      expect: () => context.expect(),
      *set(value: T) {
        yield* context.set(value);
      },
    };
  },
  createApi<Methods extends object>(name: string, defaults: Methods): Api<Methods, EffectionYield> {
    if (Object.values(defaults).some((value) => typeof value !== "function")) {
      throw new TypeError("API declarations must contain only operation methods");
    }
    const binding = createContext<{ scope: Scope; driver: Methods }>(`${name}:driver`);
    // Drivers replace the core, not a middleware layer. Native decoration still
    // surrounds the nearest binding, including inherited min middleware.
    const core = Object.fromEntries(
      Object.keys(defaults).map((key) => [
        key,
        function* (...args: unknown[]) {
          const target = (yield* binding.get())?.driver ?? defaults;
          return yield* Reflect.apply(
            target[key as keyof Methods] as (...args: unknown[]) => Operation<unknown>,
            target,
            args,
          );
        },
      ]),
    );
    // Dynamic enumeration erases the per-key signature correlation once here.
    const api = createApi(name, core) as unknown as Pick<
      Api<Methods, EffectionYield>,
      "operations" | "around"
    >;
    return {
      operations: api.operations,
      around(middleware, options) {
        return api.around(middleware, options);
      },
      *install(driver) {
        const scope = yield* useScope();
        if ((yield* binding.get())?.scope === scope) {
          throw new Error(`Driver already installed in this scope: ${name}`);
        }
        yield* binding.set({ scope, driver });
      },
    };
  },
};
