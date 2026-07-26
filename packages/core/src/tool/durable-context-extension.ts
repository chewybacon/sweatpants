import type { Around, Operation, Scope } from "effection";
import { createApi } from "effection/experimental";

import { canonicalJson, sha256 } from "@sweatpants/foundation";
import type { DurableProgramContext, Json } from "@sweatpants/session-contract";

export type DurableClientMethod = (...args: any[]) => Operation<any>;
export type DurableClientShape = Readonly<Record<string, DurableClientMethod>>;

export interface DurableClientApi<Client extends DurableClientShape> {
  around(
    middleware: Partial<Around<Client>>,
    options?: { readonly at: "min" | "max" },
  ): Operation<void>;
  /** @internal Invokes one semantic client method through recursive middleware. */
  invoke(
    scope: Scope,
    key: keyof Client,
    args: readonly unknown[],
    implementation: Client,
  ): Operation<Json>;
}

export interface DurableContextExtensionOptions<
  Name extends string,
  Api extends DurableClientShape,
  Client extends DurableClientShape,
> {
  readonly name: Name;
  /** Ordinary API projection used when no custom semantic client is supplied. */
  readonly api: Api;
  /** Optional semantic composition. This code is pinned into program identity. */
  readonly client?: (helpers: {
    readonly api: Api;
    readonly self: Client;
    readonly context: DurableProgramContext;
  }) => Client;
}

const extensionBrand: unique symbol = Symbol("DurableContextExtension");

export interface DurableContextExtension<
  Name extends string = string,
  Client extends DurableClientShape = DurableClientShape,
> {
  readonly [extensionBrand]: true;
  readonly name: Name;
  readonly digest: string;
  readonly api: DurableClientApi<Client>;
  /** Alias retained as a descriptive middleware surface for client composition. */
  readonly clientApi: DurableClientApi<Client>;
  /** @internal Creates one attachment-scope semantic client. */
  createClient(context: DurableProgramContext): Client;
}

export type ExtensionClient<T> =
  T extends DurableContextExtension<string, infer Client> ? Client : never;
export type DurableExtensionMap = Readonly<Record<string, DurableContextExtension<any, any>>>;

export type DurableExtensionContext<Extensions extends DurableExtensionMap> = {
  readonly [Alias in keyof Extensions]: ExtensionClient<Extensions[Alias]>;
} & {
  use<Token extends Extensions[keyof Extensions]>(token: Token): ExtensionClient<Token>;
};

/**
 * Defines a namespace of ordinary Effection Operations. Namespace membership
 * never creates a durable boundary; semantic client code must call an explicit
 * DurableProgramContext API when durability is intended.
 */
export function defineDurableContextExtension<
  const Name extends string,
  const Api extends DurableClientShape,
  Client extends DurableClientShape = Api,
>(
  options: DurableContextExtensionOptions<Name, Api, Client>,
): DurableContextExtension<Name, Client> {
  if (!options.name.trim()) {
    throw new Error("Durable context extension name must be non-empty");
  }
  const apiKeys = Object.keys(options.api);
  if (apiKeys.length === 0) {
    throw new Error("Durable context extension API must declare at least one ordinary method");
  }
  for (const key of apiKeys) {
    if (!key || typeof options.api[key] !== "function") {
      throw new Error("Durable context extension API must contain named Effection methods");
    }
  }

  // Calling the semantic factory only constructs closures; it does not execute
  // authored Operations. This discovers the closed middleware method surface.
  let discovered: Client;
  const unavailableContext = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`Durable extension ${options.name} is not context-bound`);
        };
      },
    },
  ) as DurableProgramContext;
  const unavailableSelf = new Proxy(
    {},
    {
      get() {
        return () => {
          throw new Error(`Durable extension ${options.name} is not context-bound`);
        };
      },
    },
  ) as Client;
  discovered = options.client
    ? options.client({ api: options.api, self: unavailableSelf, context: unavailableContext })
    : (options.api as unknown as Client);
  const methodKeys = Object.keys(discovered) as (keyof Client & string)[];
  if (methodKeys.length === 0 || methodKeys.some((key) => typeof discovered[key] !== "function")) {
    throw new Error("Durable context extension client must contain named Effection methods");
  }

  type InternalMethod = (implementation: Client, ...args: unknown[]) => Operation<Json>;
  const internalCore = Object.fromEntries(
    methodKeys.map((key) => [
      key,
      (implementation: Client, ...args: unknown[]) => {
        const method = implementation[key] as (...values: unknown[]) => Operation<Json>;
        return method(...args);
      },
    ]),
  ) as Record<string, InternalMethod>;
  const internalApi = createApi(`durable-extension:${options.name}`, internalCore);
  const clientApi: DurableClientApi<Client> = {
    around(middleware, aroundOptions) {
      const adapted = Object.fromEntries(
        Object.entries(middleware).map(([key, candidate]) => [
          key,
          (args: unknown[], next: (...nextArgs: unknown[]) => unknown) => {
            const implementation = args[0] as Client;
            const method = candidate as (
              args: unknown[],
              next: (...nextArgs: unknown[]) => unknown,
            ) => unknown;
            return method(args.slice(1), (...nextArgs) => next(implementation, ...nextArgs));
          },
        ]),
      );
      return internalApi.around(adapted as Parameters<typeof internalApi.around>[0], aroundOptions);
    },
    invoke(scope, key, args, implementation) {
      return internalApi.invoke(scope, key as string, [implementation, ...args]) as Operation<Json>;
    },
  };

  const digest = sha256(
    canonicalJson({
      name: options.name,
      api: Object.fromEntries(apiKeys.sort().map((key) => [key, sha256(String(options.api[key]))])),
      client: options.client ? sha256(String(options.client)) : "default-api-projection",
    }),
  );

  const extension: DurableContextExtension<Name, Client> = {
    [extensionBrand]: true,
    name: options.name,
    digest,
    api: clientApi,
    clientApi,
    createClient(context) {
      let bound: Client;
      const self = new Proxy(
        {},
        {
          get(_target, key) {
            const method = bound[key as keyof Client];
            if (typeof method !== "function") {
              throw new Error(`Unknown durable extension method ${String(key)}`);
            }
            return method.bind(bound);
          },
        },
      ) as Client;
      const implementation = Object.freeze(
        options.client
          ? options.client({ api: options.api, self, context })
          : (options.api as unknown as Client),
      );
      bound = Object.freeze(
        Object.fromEntries(
          methodKeys.map((key) => [
            key,
            (...args: unknown[]) =>
              (function* () {
                const method = internalApi.operations[key] as unknown as (
                  implementation: Client,
                  ...values: unknown[]
                ) => Operation<Json>;
                return yield* method(implementation, ...args);
              })(),
          ]),
        ),
      ) as unknown as Client;
      return bound;
    },
  };
  return Object.freeze(extension);
}

/** Validates aliases and rejects duplicate extension tokens. */
export function validateDurableExtensionDeclarations(extensions: DurableExtensionMap): void {
  const tokens = new Set<DurableContextExtension>();
  for (const [alias, extension] of Object.entries(extensions)) {
    assertExtensionAlias(alias);
    if (tokens.has(extension)) {
      throw new Error(`Durable context extension ${extension.name} is declared more than once`);
    }
    tokens.add(extension);
  }
}

const RESERVED_ALIASES = new Set([
  "effect",
  "record",
  "use",
  "sample",
  "elicit",
  "invoke",
  "all",
  "race",
  "spawn",
  "clock",
  "emit",
  "log",
  "notify",
  "signal",
  "messages",
]);

function assertExtensionAlias(alias: string): void {
  if (!alias || RESERVED_ALIASES.has(alias)) {
    throw new Error(`Reserved durable context extension alias ${alias}`);
  }
}
