import type { Around, Operation, Scope } from "effection";
import { createApi } from "effection/experimental";
import { effectRuntimeValidators } from "./durable-effect.ts";

import {
  canonicalJson,
  createDurableEffectRegistration,
  durableProgramScope,
  effectContractDigest,
  sha256,
  type DurableEffectContext,
  type DurableEffectRegistration,
  type DurableProgramContext,
  type EffectDefinition,
  type Json,
  type ProgramResume,
  type ProgramStepProposal,
} from "@sweatpants/session-contract";

export type DurableExtensionEffectMap = Readonly<
  Record<string, EffectDefinition<Json, Json, Json>>
>;

export type DurableClientMethod = (
  input: never,
) => Generator<ProgramStepProposal, Json, ProgramResume>;
export type DurableClientShape = Readonly<Record<string, DurableClientMethod>>;

type EffectInput<D> = D extends EffectDefinition<infer I, Json, Json> ? I : never;
type EffectOutput<D> = D extends EffectDefinition<Json, infer O, Json> ? O : never;

type DefaultClient<Effects extends DurableExtensionEffectMap> = {
  readonly [Key in keyof Effects]: (
    input: EffectInput<Effects[Key]>,
  ) => Generator<ProgramStepProposal, EffectOutput<Effects[Key]>, ProgramResume>;
};

export type DurableExtensionRuntime<Effects extends DurableExtensionEffectMap> = {
  readonly [Key in keyof Effects]: (
    input: EffectInput<Effects[Key]>,
    context: DurableEffectContext,
  ) => Operation<EffectOutput<Effects[Key]>>;
};

export interface DurableClientApi<Client extends DurableClientShape> {
  around(
    middleware: Partial<Around<Client>>,
    options?: { readonly at: "min" | "max" },
  ): Operation<void>;
  /** @internal Invokes one client method with a context-bound implementation. */
  invoke(
    scope: Scope,
    key: keyof Client,
    args: readonly unknown[],
    implementation: Client,
  ): Generator<ProgramStepProposal, Json, ProgramResume>;
}

export interface DurableExtensionProvider {
  readonly name: string;
  readonly registrations: readonly DurableEffectRegistration[];
  install(): Operation<void>;
}

export interface DurableExtensionEffectCaller<Effects extends DurableExtensionEffectMap> {
  <Key extends keyof Effects>(
    definition: Effects[Key],
    input: EffectInput<Effects[Key]>,
  ): Generator<ProgramStepProposal, EffectOutput<Effects[Key]>, ProgramResume>;
}

export interface DurableContextExtensionOptions<
  Name extends string,
  Effects extends DurableExtensionEffectMap,
  Client extends DurableClientShape,
> {
  readonly name: Name;
  readonly effects: Effects;
  readonly client?: (helpers: {
    readonly effect: DurableExtensionEffectCaller<Effects>;
    readonly self: Client;
  }) => Client;
}

const extensionBrand: unique symbol = Symbol("DurableContextExtension");

export interface DurableContextExtension<
  Name extends string = string,
  Effects extends DurableExtensionEffectMap = DurableExtensionEffectMap,
  Client extends DurableClientShape = DurableClientShape,
> {
  readonly [extensionBrand]: true;
  readonly name: Name;
  readonly digest: string;
  readonly effects: Effects;
  readonly clientApi: DurableClientApi<Client>;
  readonly runtimeApi: ReturnType<typeof createApi<DurableExtensionRuntime<Effects>>>;
  implement(options: {
    readonly name: string;
    readonly methods: DurableExtensionRuntime<Effects>;
  }): DurableExtensionProvider;
  /** @internal Creates one context-bound client over the program's declared effect function. */
  createClient(context: DurableProgramContext): Client;
}

export type ExtensionClient<T> =
  T extends DurableContextExtension<string, any, infer Client> ? Client : never;
export type ExtensionEffects<T> =
  T extends DurableContextExtension<string, infer Effects, any> ? Effects : never;
export type DurableExtensionMap = Readonly<Record<string, DurableContextExtension<any, any, any>>>;

export type DurableExtensionContext<Extensions extends DurableExtensionMap> = {
  readonly [Alias in keyof Extensions]: ExtensionClient<Extensions[Alias]>;
} & {
  use<Token extends Extensions[keyof Extensions]>(token: Token): ExtensionClient<Token>;
};

export function defineDurableContextExtension<
  const Name extends string,
  const Effects extends DurableExtensionEffectMap,
  Client extends DurableClientShape = DefaultClient<Effects>,
>(
  options: DurableContextExtensionOptions<Name, Effects, Client>,
): DurableContextExtension<Name, Effects, Client> {
  if (!options.name.trim()) {
    throw new Error("Durable context extension name must be non-empty");
  }
  if (Object.keys(options.effects).length === 0) {
    throw new Error("Durable context extension must declare at least one effect");
  }
  const effectEntries = Object.entries(options.effects);
  for (const [key, definition] of effectEntries) {
    if (!key || !definition || typeof definition !== "object") {
      throw new Error("Durable context extension effects must be named definitions");
    }
  }

  const unavailableEffect = () =>
    (function* (): Generator<ProgramStepProposal, Json, ProgramResume> {
      throw new Error(`Durable extension ${options.name} is not context-bound`);
    })();
  const shape = options.client
    ? options.client({
        effect: unavailableEffect as DurableExtensionEffectCaller<Effects>,
        self: new Proxy({}, { get: () => unavailableEffect }) as Client,
      })
    : (Object.fromEntries(
        effectEntries.map(([key]) => [key, unavailableEffect]),
      ) as unknown as Client);
  const methodKeys = Object.keys(shape) as (keyof Client & string)[];
  type InternalMethod = (
    implementation: Client,
    ...args: unknown[]
  ) => Generator<ProgramStepProposal, Json, ProgramResume>;
  const internalCore = Object.fromEntries(
    methodKeys.map((key) => [
      key,
      (implementation: Client, ...args: unknown[]) => {
        const method = implementation[key] as unknown as (
          ...values: unknown[]
        ) => Generator<ProgramStepProposal, Json, ProgramResume>;
        return method(...args);
      },
    ]),
  ) as Record<string, InternalMethod>;
  const internalClientApi = createApi(`durable-extension:${options.name}`, internalCore);
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
      return internalClientApi.around(
        adapted as unknown as Parameters<typeof internalClientApi.around>[0],
        aroundOptions,
      );
    },
    invoke(scope, key, args, implementation) {
      return internalClientApi.invoke(scope, key as string, [implementation, ...args]) as Generator<
        ProgramStepProposal,
        Json,
        ProgramResume
      >;
    },
  };
  const runtimeCore = Object.fromEntries(
    effectEntries.map(([key]) => [
      key,
      function* () {
        throw new Error(`Durable extension provider ${options.name}.${key} is not installed`);
      },
    ]),
  ) as unknown as DurableExtensionRuntime<Effects>;
  const runtimeApi = createApi(`durable-extension-runtime:${options.name}`, runtimeCore);
  const digest = sha256(
    canonicalJson({
      name: options.name,
      effects: Object.fromEntries(
        effectEntries.map(([key, definition]) => [key, effectContractDigest(definition)]),
      ),
      client: options.client ? sha256(String(options.client)) : "generated",
    }),
  );

  const extension: DurableContextExtension<Name, Effects, Client> = {
    [extensionBrand]: true,
    name: options.name,
    digest,
    effects: options.effects,
    clientApi,
    runtimeApi,
    implement(providerOptions) {
      if (!providerOptions.name.trim()) {
        throw new Error("Durable extension provider name must be non-empty");
      }
      for (const key of Object.keys(options.effects)) {
        const method = providerOptions.methods[key as keyof typeof providerOptions.methods];
        if (typeof method !== "function") {
          throw new Error(`Durable extension provider is missing ${key}`);
        }
        if (method.constructor.name === "AsyncFunction") {
          throw new Error(`Durable extension provider ${key} must return an Effection Operation`);
        }
      }
      const middleware = Object.fromEntries(
        Object.keys(options.effects).map((key) => [
          key,
          (args: readonly unknown[]) => {
            const method = providerOptions.methods[
              key as keyof typeof providerOptions.methods
            ] as unknown as (input: Json, context: DurableEffectContext) => Operation<Json>;
            return method(args[0] as Json, args[1] as DurableEffectContext);
          },
        ]),
      ) as unknown as Parameters<typeof runtimeApi.around>[0];
      const registrations = Object.freeze(
        effectEntries.map(([key, definition]) =>
          createDurableEffectRegistration(
            definition,
            definition.retrySafety,
            function* (input, context) {
              // Install the provider in the attempt scope so detached framework
              // writer tasks do not depend on request-scope context inheritance.
              yield* runtimeApi.around(middleware, { at: "min" });
              const method = runtimeApi.operations[key as keyof Effects] as unknown as (
                input: Json,
                context: DurableEffectContext,
              ) => Operation<Json>;
              const value = yield* method(input, context);
              return { status: "ok" as const, value };
            },
            effectRuntimeValidators(definition),
          ),
        ),
      );
      return Object.freeze({
        name: providerOptions.name,
        registrations,
        *install() {
          // Provider registrations install their implementation in each
          // authorized attempt scope; this hook remains for assembly symmetry.
        },
      });
    },
    createClient(context) {
      const effect = ((definition: EffectDefinition<Json, Json, Json>, input: Json) =>
        context.effect(definition, input, {
          audience: `extension:${options.name}`,
        })) as DurableExtensionEffectCaller<Effects>;
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
      const implementation = options.client
        ? Object.freeze(options.client({ effect, self }))
        : (Object.freeze(
            Object.fromEntries(
              effectEntries.map(([key, definition]) => [
                key,
                (input: Json) => {
                  const invoke = effect as unknown as (
                    definition: EffectDefinition<Json, Json, Json>,
                    input: Json,
                  ) => Generator<ProgramStepProposal, Json, ProgramResume>;
                  return invoke(definition, input);
                },
              ]),
            ),
          ) as unknown as Client);
      bound = Object.freeze(
        Object.fromEntries(
          methodKeys.map((key) => [
            key,
            (...args: unknown[]) =>
              (function* () {
                const scope = durableProgramScope(context);
                return yield* clientApi.invoke(scope, key, args, implementation);
              })(),
          ]),
        ),
      ) as unknown as Client;
      return bound;
    },
  };
  return Object.freeze(extension);
}

export function extensionEffectDefinitions(
  extensions: DurableExtensionMap,
): Record<string, EffectDefinition<Json, Json, Json>> {
  const definitions: Record<string, EffectDefinition<Json, Json, Json>> = {};
  const tokens = new Set<DurableContextExtension>();
  for (const [alias, extension] of Object.entries(extensions)) {
    assertExtensionAlias(alias);
    if (tokens.has(extension)) {
      throw new Error(`Durable context extension ${extension.name} is declared more than once`);
    }
    tokens.add(extension);
    for (const candidate of Object.values(extension.effects)) {
      const definition = candidate as EffectDefinition<Json, Json, Json>;
      const existing = definitions[definition.name];
      if (existing && canonicalJson(existing) !== canonicalJson(definition)) {
        throw new Error(`Conflicting durable effect definition ${definition.name}`);
      }
      definitions[definition.name] = definition;
    }
  }
  return definitions;
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
