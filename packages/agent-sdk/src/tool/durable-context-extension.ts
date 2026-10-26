import type { Operation } from "effection";
import { effection, type EffectionYield } from "@sweatpants/standard-durability-effection";
import type { Api as ComposedApi, Operations } from "@sweatpants/standard-durability";

import { canonicalJson, sha256 } from "@sweatpants/foundation";
import type { DurableProgramContext } from "@sweatpants/durable-execution";

export type DurableClientMethod = (...args: any[]) => Operation<any>;
export type DurableClientShape = Readonly<Record<string, DurableClientMethod>>;

type ClientSignature<Client extends DurableClientShape> = {
  [K in keyof Client]: Client[K] extends (...args: infer Args) => Operation<infer Result>
    ? (...args: Args) => Result
    : never;
};

export type DurableClientApi<Client extends DurableClientShape> = Pick<
  ComposedApi<ClientSignature<Client>, EffectionYield>,
  "around"
>;

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
  /** @internal Installs the semantic client in the current invocation scope. */
  installClient(context: DurableProgramContext): Operation<Client>;
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

  // Dynamic method discovery loses the mapped key/signature correlation once here.
  const defaults = Object.fromEntries(
    methodKeys.map((key) => [
      key,
      function* () {
        throw new Error(`Durable extension ${options.name} is not context-bound`);
      },
    ]),
  ) as unknown as Operations<ClientSignature<Client>, EffectionYield>;
  const composed = effection.createApi<ClientSignature<Client>>(
    `durable-extension:${options.name}`,
    defaults,
  );
  const clientApi: DurableClientApi<Client> = { around: composed.around };

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
    *installClient(context) {
      // Calls, including recursive self calls, resolve through the same installed API.
      const self = composed.operations as unknown as Client;
      const implementation = options.client
        ? options.client({ api: options.api, self, context })
        : (options.api as unknown as Client);
      yield* composed.install(
        implementation as unknown as Operations<ClientSignature<Client>, EffectionYield>,
      );
      return self;
    },
  };
  return Object.freeze(extension);
}

/** Validates aliases and rejects duplicate extension tokens. */
export function assertDurableExtensionDeclarations(extensions: DurableExtensionMap): void {
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
