import { createContext, ensure, scoped, useScope, type Operation, type Scope } from "effection";
import { createApi } from "effection/experimental";
import type {
  Api,
  ApiDefaults,
  OperationMethods,
  Composition,
  Context,
} from "@standard-durability/core";
import {
  describeSync,
  assertSynchronous,
  readMember,
  bindMembers,
  synchronousDecorator,
  mergeDriver,
  apiKey,
  type RawDecorator,
  type RawDefinition,
} from "@standard-durability/core/internal";
import type { EffectionYield } from "./contracts.ts";

/** Reference adapter, using native scopes and middleware rather than a new scheduler. */
export const effection: Composition<EffectionYield> = {
  *catchError(work, recover) {
    try {
      return yield* work();
    } catch (error) {
      return yield* recover(error);
    }
  },
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
  createApi<O extends OperationMethods<O, EffectionYield> = {}, S extends object = {}>(
    name: string,
    defaults: ApiDefaults<O, S>,
  ): Api<O, EffectionYield, S> {
    const members = describeSync(defaults.sync);
    const binding = createContext<{ scope: Scope; driver: RawDefinition }>(apiKey(name, "driver"));
    const core = Object.fromEntries(
      Object.keys(defaults.operations ?? {}).map((key) => [
        key,
        function* (...args: unknown[]) {
          const target = (yield* binding.get())?.driver ?? defaults;
          return yield* readMember(
            target.operations ?? {},
            key,
            args,
            "method",
          ) as Operation<unknown>;
        },
      ]),
    );
    const api = createApi(apiKey(name, "operations"), core);
    let invokingScope: Scope | undefined;
    const synchronous = createApi(
      apiKey(name, "sync"),
      Object.fromEntries(
        [...members].map(([key, kind]) => [
          key,
          (...args: unknown[]) => {
            if (!invokingScope) {
              throw new Error("Missing synchronous invocation scope");
            }
            const target = invokingScope.get(binding)?.driver ?? defaults;
            return assertSynchronous(readMember(target.sync ?? {}, key, args, kind));
          },
        ]),
      ),
    );
    function invoke(scope: Scope, key: string, args: unknown[]) {
      const previous = invokingScope;
      invokingScope = scope;
      try {
        return assertSynchronous(synchronous.invoke(scope, key, args));
      } finally {
        invokingScope = previous;
      }
    }
    return {
      operations: api.operations as unknown as O,
      *around(middleware, options) {
        // Translate signature-preserving decorators to native Effection interception.
        const translate = (layers: object = {}, sync = false) =>
          Object.fromEntries(
            Object.entries(layers)
              .filter(([, value]) => value)
              .map(([key, value]) => {
                const decorate = sync
                  ? synchronousDecorator(value as RawDecorator)
                  : (value as RawDecorator);
                return [
                  key,
                  (args: unknown[], next: (...args: unknown[]) => unknown) =>
                    decorate(next)(...args),
                ];
              }),
          );
        yield* api.around(
          translate(middleware.operations) as Parameters<typeof api.around>[0],
          options,
        );
        yield* synchronous.around(translate(middleware.sync, true), options);
      },
      *install(replacement) {
        const scope = yield* useScope();
        const current = yield* binding.get();
        if (current?.scope === scope) {
          throw new Error(`Driver already installed in this scope: ${name}`);
        }
        yield* binding.set({
          scope,
          driver: mergeDriver(current?.driver ?? defaults, replacement),
        });
      },
      *[Symbol.iterator]() {
        const scope = yield* useScope();
        let active = true;
        yield* ensure(function* () {
          active = false;
        });
        return bindMembers(members, (key, args) => {
          if (!active) {
            throw new Error("API access scope is closed");
          }
          return invoke(scope, key, args);
        }) as Readonly<S>;
      },
    };
  },
};
