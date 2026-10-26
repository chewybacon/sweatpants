import { createContext, ensure, scoped, useScope, type Operation, type Scope } from "effection";
import { createApi } from "effection/experimental";
import type {
  Api,
  Composition,
  Context,
  Middleware,
  Operations,
  Operation as PortableOperation,
} from "./contracts.ts";

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
    // Every member here already returns a native-compatible Operation. Effection's
    // additional plain-value lifting branches are unreachable, but TypeScript
    // cannot reduce the nested conditional mapped types for a generic Signature.
    const api = createApi(name, defaults) as unknown as Pick<
      Api<Signature, EffectionYield>,
      "operations" | "around"
    >;
    const owner = createContext<Scope>(`${name}:driver-owner`);
    return {
      operations: api.operations,
      around(middleware, options) {
        return api.around(middleware, options);
      },
      *install(driver) {
        const scope = yield* useScope();
        if ((yield* owner.get()) === scope) {
          throw new Error(`Driver already installed in this scope: ${name}`);
        }
        // The dynamic property loop loses each key's argument/value correlation.
        // Restore it once here; the public surface retains the exact signature.
        const terminal = Object.fromEntries(
          Object.keys(defaults).map((key) => [
            key,
            (args: unknown[]) =>
              Reflect.apply(
                driver[key as keyof Signature] as (...args: unknown[]) => unknown,
                driver,
                args,
              ),
          ]),
        ) as unknown as Middleware<Signature, EffectionYield>;
        yield* api.around(terminal, { at: "min" });
        yield* owner.set(scope);
      },
    };
  },
};
