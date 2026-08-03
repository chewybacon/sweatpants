/**
 * Framework-neutral client elicitation contracts.
 *
 * This module owns only the client interaction contract. It does not register
 * executable tools, expose server inventory, or persist frontend state.
 * Frontend packages specialize the capability type and expose their own
 * `makePlugin` facade.
 */
import type { Operation } from "effection";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { assertJson, canonicalJson, sha256, type Json } from "@sweatpants/foundation";
import type { PortableSchemaDescriptor } from "@sweatpants/foundation/schema";
import {
  computeToolInterfaceDigest,
  type ElicitDefinition,
  type ElicitsMap,
  type ExtractElicitContext,
  type ExtractElicitResponseInput,
  type ToolContract,
  type ToolElicitSchemaArtifact,
  type ToolExecutionKind,
  type ElicitExchangeCompletion,
} from "@sweatpants/agent-sdk";

/** Domain separation required for client binding identity. */
export const CLIENT_ELICIT_BINDING_DOMAIN = "sweatpants.client-elicit-binding\n";

/** Correlation facts supplied to an authored handler as immutable data. */
export interface ElicitHandlerMetadata<TKey extends string = string> {
  readonly id: {
    readonly toolName: string;
    readonly key: TKey;
    readonly callId: string;
    readonly seq: number;
  };
}

/** Strongly typed input constructed after client-boundary validation. */
export interface ElicitHandlerInput<TDefinition> {
  readonly message: string;
  readonly context: ExtractElicitContext<TDefinition>;
}

/**
 * Canonical handler shape. The capability type is supplied by a frontend
 * package; the shared core does not constrain native handles or props.
 */
export type ElicitHandler<TKey extends string, TDefinition, TCapabilities> = (
  input: ElicitHandlerInput<TDefinition>,
  capabilities: TCapabilities,
  metadata: ElicitHandlerMetadata<TKey>,
) => Operation<ElicitExchangeCompletion<ExtractElicitResponseInput<TDefinition>>>;

export type ElicitHandlers<TNormalized, TCapabilities> = {
  [K in keyof TNormalized & string]: ElicitHandler<K, TNormalized[K], TCapabilities>;
};

/** Exact interface facts committed by a client binding digest. */
export interface ClientElicitBindingIdentityInput {
  readonly ownerInterfaceDigest: string;
  readonly key: string;
  readonly response: PortableSchemaDescriptor;
  readonly context: PortableSchemaDescriptor | null;
  readonly clientMetadata: Json;
}

/** Compute the lowercase hexadecimal binding digest defined by REQ-038. */
export function computeClientElicitBindingId(input: ClientElicitBindingIdentityInput): string {
  const canonical = canonicalJson({
    ownerInterfaceDigest: input.ownerInterfaceDigest,
    key: input.key,
    response: input.response,
    context: input.context,
    clientMetadata: assertJson(input.clientMetadata),
  });
  return sha256(`${CLIENT_ELICIT_BINDING_DOMAIN}${canonical}`);
}

/** Runtime binding installed in a client-only registry. */
export interface ClientElicitBinding<TDefinition = unknown, TCapabilities = unknown> {
  readonly bindingId: string;
  readonly ownerInterfaceDigest: string;
  readonly toolName: string;
  readonly key: string;
  readonly responseContract: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
  readonly responseSchema: StandardSchemaV1;
  readonly contextSchema?: StandardSchemaV1;
  readonly artifacts: ToolElicitSchemaArtifact;
  readonly clientMetadata: Json;
  readonly handler: ElicitHandler<string, TDefinition, TCapabilities>;
}

/** The only registration shape consumed by the client dispatcher. */
export interface ClientPluginRegistration<TCapabilities = unknown> {
  readonly toolName: string;
  readonly ownerInterfaceDigest: string;
  readonly bindings: ReadonlyMap<string, ClientElicitBinding<unknown, TCapabilities>>;
}

/** Framework-facing plugin object. It intentionally has no server registration. */
export interface ClientPlugin<TCapabilities = unknown> {
  readonly client: ClientPluginRegistration<TCapabilities>;
}

export type PluginToolContract<TElicits extends ElicitsMap = ElicitsMap> = ToolContract<
  string,
  any,
  any,
  TElicits,
  any
> & {
  readonly execution: ToolExecutionKind;
};

export interface PluginBuilder<TContract extends PluginToolContract, TCapabilities> {
  onElicit(
    handlers: ElicitHandlers<TContract["elicits"], TCapabilities>,
  ): PluginBuilderWithHandlers<TCapabilities>;
}

export interface PluginBuilderWithHandlers<TCapabilities> {
  build(): ClientPlugin<TCapabilities>;
}

/**
 * Build the framework-neutral portion of a client plugin. Frontend packages
 * call this with their complete capability context and re-export a facade.
 */
export function createPluginBuilder<TCapabilities, TContract extends PluginToolContract>(
  tool: TContract,
): PluginBuilder<TContract, TCapabilities> {
  return {
    onElicit(handlers) {
      return {
        build(): ClientPlugin<TCapabilities> {
          const ownerInterfaceDigest =
            tool.interfaceDigest ??
            computeToolInterfaceDigest({
              name: tool.name,
              parameters: tool.artifacts.parameters,
              ...(tool.artifacts.output ? { output: tool.artifacts.output } : {}),
              elicits: tool.artifacts.elicits,
              annotations: tool.annotations,
              extensions: tool.extensions,
            });
          const bindings = new Map<string, ClientElicitBinding<unknown, TCapabilities>>();
          for (const key of Object.keys(tool.elicits)) {
            const definition = tool.elicits[key] as ElicitDefinition;
            const artifact = tool.artifacts.elicits[key];
            if (!artifact) {
              throw new Error(
                `Tool "${tool.name}" has no schema artifact for elicitation "${key}"`,
              );
            }
            const handler = handlers[key as keyof typeof handlers] as ElicitHandler<
              string,
              unknown,
              TCapabilities
            >;
            if (typeof handler !== "function") {
              throw new Error(`Tool "${tool.name}" has no handler for elicitation "${key}"`);
            }
            const clientMetadata = assertJson(definition.metadata ?? null);
            const bindingId = computeClientElicitBindingId({
              ownerInterfaceDigest,
              key,
              response: artifact.response,
              context: artifact.context ?? null,
              clientMetadata,
            });
            const binding: ClientElicitBinding<unknown, TCapabilities> = {
              bindingId,
              ownerInterfaceDigest,
              toolName: tool.name,
              key,
              responseContract: artifact.response,
              ...(artifact.context ? { contextContract: artifact.context } : {}),
              responseSchema: definition.response,
              ...(definition.context ? { contextSchema: definition.context } : {}),
              artifacts: artifact,
              clientMetadata,
              handler,
            };
            bindings.set(bindingId, Object.freeze(binding));
          }
          return Object.freeze({
            client: Object.freeze({
              toolName: tool.name,
              ownerInterfaceDigest,
              bindings,
            }),
          });
        },
      };
    },
  };
}

/** Generic facade for non-framework callers and tests. */
export function makePlugin<TContract extends PluginToolContract, TCapabilities = unknown>(
  tool: TContract,
): PluginBuilder<TContract, TCapabilities> {
  return createPluginBuilder<TCapabilities, TContract>(tool);
}

/** Registry keyed by exact binding identity, never by tool name and key alone. */
export interface PluginRegistry<TCapabilities = unknown> {
  register(plugin: ClientPluginRegistration<TCapabilities>): void;
  get(bindingId: string): ClientElicitBinding<unknown, TCapabilities> | undefined;
  has(bindingId: string): boolean;
  bindings(): readonly ClientElicitBinding<unknown, TCapabilities>[];
  toolNames(): string[];
  readonly size: number;
  onUpdate(listener: () => void): () => void;
}

/** Create an exact-binding client registry. */
export function createPluginRegistry<TCapabilities = unknown>(): PluginRegistry<TCapabilities> {
  const bindings = new Map<string, ClientElicitBinding<unknown, TCapabilities>>();
  const listeners = new Set<() => void>();
  return {
    register(plugin) {
      for (const [bindingId, binding] of plugin.bindings) {
        const previous = bindings.get(bindingId);
        if (previous && previous !== binding) {
          throw new Error(`Client binding "${bindingId}" is already registered`);
        }
        bindings.set(bindingId, binding);
      }
      for (const listener of listeners) {
        listener();
      }
    },
    get(bindingId) {
      return bindings.get(bindingId);
    },
    has(bindingId) {
      return bindings.has(bindingId);
    },
    bindings() {
      return [...bindings.values()];
    },
    toolNames() {
      return [...new Set([...bindings.values()].map((binding) => binding.toolName))];
    },
    get size() {
      return bindings.size;
    },
    onUpdate(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createPluginRegistryFrom<TCapabilities = unknown>(
  plugins: readonly ClientPluginRegistration<TCapabilities>[],
): PluginRegistry<TCapabilities> {
  const registry = createPluginRegistry<TCapabilities>();
  for (const plugin of plugins) {
    registry.register(plugin);
  }
  return registry;
}

/** Transport-neutral raw request consumed by the dispatcher. */
export interface RawClientElicit {
  readonly elicitId: string;
  readonly bindingId: string;
  readonly toolName: string;
  readonly key: string;
  readonly message: string;
  readonly callId: string;
  readonly seq: number;
  readonly context?: Json;
  readonly responseContract: PortableSchemaDescriptor;
  readonly contextContract?: PortableSchemaDescriptor;
  readonly placement: {
    readonly nodeId: string;
    readonly parentNodeId: string | null;
    readonly sequence: number;
  };
}

export type ClientElicitRequest = RawClientElicit;

/** Type predicate used by adapters before handing a request to the dispatcher. */
export function hasDeclaredContext(request: RawClientElicit): boolean {
  return request.contextContract !== undefined;
}

/** Convert a raw request to the authored handler input after validation. */
export function createResolvedHandlerInput<TDefinition>(
  request: Pick<RawClientElicit, "message" | "context">,
  context: ExtractElicitContext<TDefinition>,
): ElicitHandlerInput<TDefinition> {
  return {
    message: request.message,
    context,
  };
}
