import { createContext, ensure, scoped, useScope, type Operation, type Scope } from "effection";
import { createApi } from "effection/experimental";
import type {
  Api,
  Composition,
  Context,
  Operations,
  Operation as PortableOperation,
} from "@sweatpants/standard-durability";

export type EffectionYield =
  Operation<unknown> extends PortableOperation<unknown, infer Y> ? Y : never;

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
  createApi<Signature extends object>(
    name: string,
    defaults: Operations<Signature, EffectionYield>,
  ): Api<Signature, EffectionYield> {
    if (Object.values(defaults).some((value) => typeof value !== "function")) {
      throw new TypeError("API declarations must contain only operation methods");
    }
    const binding = createContext<{ scope: Scope; driver: Operations<Signature, EffectionYield> }>(
      `${name}:driver`,
    );
    // Drivers replace the core, not a middleware layer. Native decoration still
    // surrounds the nearest binding, including inherited min middleware.
    const core = Object.fromEntries(
      Object.keys(defaults).map((key) => [
        key,
        function* (...args: unknown[]) {
          const target = (yield* binding.get())?.driver ?? defaults;
          return yield* Reflect.apply(
            target[key as keyof Signature] as (...args: unknown[]) => Operation<unknown>,
            target,
            args,
          );
        },
      ]),
    );
    // Dynamic enumeration erases the per-key signature correlation once here.
    const api = createApi(name, core) as unknown as Pick<
      Api<Signature, EffectionYield>,
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
