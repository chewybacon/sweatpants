/**
 * Plugin Builder
 *
 * Derives a framework-native plugin from any execution-neutral `ToolContract`
 * (ordinary `createTool` definitions or crank-native `createDurableTool`
 * definitions). The plugin owns typed browser elicitation handlers only;
 * execution placement stays with deployment composition.
 *
 * ## Usage
 *
 * @example Derive a plugin from a tool contract
 * ```typescript
 * const bookFlight = createTool('book_flight')
 *   .description('Book a flight')
 *   .parameters(z.object({ destination: z.string() }))
 *   .elicits({
 *     pickFlight: z.object({ flightId: z.string() }),
 *     confirm: z.object({ ok: z.boolean() }),
 *   })
 *   .execute(function* (params, ctx) { ... })
 *
 * export const bookFlightPlugin = makePlugin(bookFlight)
 *   .onElicit({
 *     pickFlight: function* (req, ctx) {
 *       const { flightId } = yield* ctx.render(FlightPicker, { ... })
 *       return { action: 'accept', content: { flightId } }
 *     },
 *     confirm: function* (req, ctx) {
 *       const { ok } = yield* ctx.render(Confirm, { message: req.message })
 *       return { action: ok ? 'accept' : 'decline', content: { ok } }
 *     },
 *   })
 *   .build()
 * ```
 *
 * @example Register on client; route execution in server composition
 * ```typescript
 * // Client
 * useChat({ plugins: [bookFlightPlugin] })
 *
 * // Server composition routes by plugin.server.execution:
 * //  - "ordinary"      → ToolSession / worker runtime
 * //  - "crank_native"  → durable ProgramDriver placement
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from "effection";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ComponentTypeLike } from "../browser-rendering/emissions.ts";
import type {
  ElicitDefinition,
  ElicitsMap,
  NormalizedElicitsMap,
  ToolExecutionKind,
  ToolSchemaArtifacts,
} from "@sweatpants/agent-sdk";
import type { ElicitRequest, WireElicitResult } from "./mcp-tool-types.ts";

// Re-export renderable types for plugin authors
export type {
  RenderableProps,
  UserProps,
  ExtractResponse,
} from "../browser-rendering/browser-context.ts";

// =============================================================================
// CLIENT CONTEXT (what onElicit handlers receive)
// =============================================================================

import type { UserProps, ExtractResponse } from "../browser-rendering/browser-context.ts";

/**
 * Context available to onElicit handlers.
 */
export interface PluginClientContext<TElicitRequest = ElicitRequest<string, any>> {
  /** Tool call ID */
  callId: string;

  /** Abort signal for cancellation */
  signal: AbortSignal;

  /** The current elicitation request */
  elicitRequest: TElicitRequest;

  /**
   * Render a React component and wait for user response.
   */
  render<TProps, TResponse = ExtractResponse<TProps>>(
    Component: ComponentTypeLike<TProps>,
    props: UserProps<TProps>,
  ): Operation<TResponse>;

  /** Report progress to the UI. */
  reportProgress?(message: string): Operation<void>;
}

// =============================================================================
// CONTRACT SHAPE ACCEPTED BY makePlugin
// =============================================================================

/**
 * Minimal execution-neutral contract surface consumed by `makePlugin`. Both
 * ordinary `ToolDefinition` and durable `DurableToolDefinition` satisfy it.
 * No callable execution surface is required.
 */
export interface PluginToolContract {
  readonly execution: ToolExecutionKind;
  readonly name: string;
  readonly description: string;
  readonly elicits: NormalizedElicitsMap<any>;
  readonly artifacts: ToolSchemaArtifacts;
}

/** Pre-validation (Standard Schema input) content type of one normalized elicit. */
export type NormalizedElicitResponseInput<D> = D extends {
  readonly response: StandardSchemaV1<infer I, any>;
}
  ? I
  : unknown;

// =============================================================================
// ELICIT HANDLER TYPES
// =============================================================================

/**
 * Handler function for a single elicitation key.
 *
 * Handler-produced accepted content is typed as the declared content schema's
 * Standard Schema **input** type; the tool/program receives the validated
 * **output** type after command-lane validation.
 */
export type ElicitHandler<TKey extends string, TDef> = (
  req: ElicitRequest<TKey, any>,
  ctx: PluginClientContext<ElicitRequest<TKey, any>>,
) => Operation<WireElicitResult<NormalizedElicitResponseInput<TDef>>>;

/**
 * Exhaustive handler map: every key declared by the contract's elicitation
 * surface must have exactly one handler.
 */
export type ElicitHandlers<TNormalized> = {
  [K in keyof TNormalized & string]: ElicitHandler<K, TNormalized[K]>;
};

/** Legacy alias mapping an authored elicits map to its handler map. */
export type ElicitHandlersFor<TElicits extends ElicitsMap> = ElicitHandlers<
  NormalizedElicitsMap<TElicits>
>;

// =============================================================================
// PLUGIN TYPES
// =============================================================================

/**
 * Execution-discriminated server-side registration.
 *
 * Registration never implies ordinary ToolSession execution: application
 * composition reads `execution` and routes the contract explicitly. Durable
 * contracts MUST NOT be installed into ordinary execution registries.
 */
export interface PluginServerRegistration<
  TContract extends PluginToolContract = PluginToolContract,
> {
  /** Tool name (for lookup) */
  toolName: string;
  /** Execution kind copied from the contract. */
  execution: ToolExecutionKind;
  /** The execution-neutral public contract this plugin serves. */
  contract: TContract;
}

/** Hydration hook restoring live components onto a replayed execution trace. */
export type PluginReplayTraceHook = (trace: any) => Operation<any>;

/**
 * Client-side registration for a plugin (execution-neutral: tool name,
 * elicitation handlers, and public schema metadata only).
 */
export interface PluginClientRegistration<TNormalized = NormalizedElicitsMap<ElicitsMap>> {
  /** Tool name (for matching incoming elicitation requests) */
  toolName: string;

  /** Elicitation handlers (exhaustive map) */
  handlers: ElicitHandlers<TNormalized>;

  /** Normalized elicitation declarations (runtime Standard Schemas). */
  schemas: TNormalized;

  /** Portable elicit schema artifacts (descriptors only). */
  artifacts?: ToolSchemaArtifacts["elicits"];

  /** Optional replay hydration hook (explicit registration metadata). */
  replayTrace?: PluginReplayTraceHook;
}

/**
 * A complete plugin derived from one execution-neutral tool contract.
 */
export interface McpPlugin<TContract extends PluginToolContract = PluginToolContract> {
  /** Execution-discriminated server-side registration. */
  server: PluginServerRegistration<TContract>;

  /** Client-side registration */
  client: PluginClientRegistration<TContract["elicits"]>;

  /** Original contract (for advanced use cases) */
  tool: TContract;
}

// =============================================================================
// PLUGIN BUILDER
// =============================================================================

/**
 * Builder for creating a plugin from a tool contract.
 */
export interface PluginBuilder<TContract extends PluginToolContract> {
  /**
   * Define exhaustive handlers for all elicitation keys declared by the
   * contract. Missing, extra, or wrongly typed handlers are compile errors.
   */
  onElicit(handlers: ElicitHandlers<TContract["elicits"]>): PluginBuilderWithHandlers<TContract>;
}

/**
 * Builder after handlers are defined - ready to build.
 */
export interface PluginBuilderWithHandlers<TContract extends PluginToolContract> {
  /** Attach an explicit replay hydration hook to the client registration. */
  onReplay(hook: PluginReplayTraceHook): PluginBuilderWithHandlers<TContract>;

  /**
   * Build the final plugin.
   */
  build(): McpPlugin<TContract>;
}

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

/**
 * Create a plugin from any execution-neutral tool contract.
 *
 * The contract must declare its elicitation surface with `.elicits({...})`.
 * The returned builder requires exhaustive handlers for every declared key.
 * Building a plugin never installs the tool into an execution registry.
 */
export function makePlugin<TContract extends PluginToolContract>(
  tool: TContract,
): PluginBuilder<TContract> {
  return {
    onElicit(handlers) {
      let replayTrace: PluginReplayTraceHook | undefined;
      const withHandlers: PluginBuilderWithHandlers<TContract> = {
        onReplay(hook) {
          replayTrace = hook;
          return withHandlers;
        },
        build(): McpPlugin<TContract> {
          return {
            tool,

            server: {
              toolName: tool.name,
              execution: tool.execution,
              contract: tool,
            },

            client: {
              toolName: tool.name,
              handlers,
              schemas: tool.elicits as TContract["elicits"],
              artifacts: tool.artifacts.elicits,
              ...(replayTrace ? { replayTrace } : {}),
            },
          };
        },
      };
      return withHandlers;
    },
  };
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the normalized elicits map from a plugin.
 */
export type InferElicits<T> = T extends McpPlugin<infer C> ? C["elicits"] : never;

/**
 * Extract the contract type from a plugin.
 */
export type InferPluginTool<T> = T extends McpPlugin<infer C> ? C : never;

/**
 * Any plugin (for arrays/registries).
 */
export type AnyMcpPlugin = McpPlugin<PluginToolContract>;

/**
 * Structural type for accepting full plugin handles in arrays.
 *
 * `useChat` receives concrete plugin objects and derives client-side
 * elicitation handlers plus the server-side `enabledPlugins` list from them.
 * Heterogeneous plugins with different elicit maps all satisfy this shape.
 */
export interface PluginHandleInput {
  /** The tool contract */
  tool: unknown;
  /** Execution-discriminated server registration */
  server: { toolName: string; execution: ToolExecutionKind; contract: unknown };
  /** Client-side registration (handlers + tool name) */
  client: PluginClientRegistrationInput;
}

/**
 * Structural type for accepting plugin client registrations in arrays.
 */
export interface PluginClientRegistrationInput {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: Record<string, (req: any, ctx: any) => Operation<WireElicitResult<unknown>>>;
  schemas: Record<string, ElicitDefinition<unknown, unknown>>;
  artifacts?: ToolSchemaArtifacts["elicits"];
  replayTrace?: PluginReplayTraceHook;
}
