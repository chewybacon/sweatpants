/**
 * MCP Plugin Builder
 *
 * Derives a framework-native plugin from a bridgeable MCP tool.
 * The plugin enables E2E execution: server runs the MCP tool,
 * client handles elicitation via UI.
 *
 * ## Usage
 *
 * @example Derive a plugin from a bridgeable tool
 * ```typescript
 * // Define the MCP tool with elicitation surface
 * const bookFlight = createTool('book_flight')
 *   .description('Book a flight')
 *   .parameters(z.object({ destination: z.string() }))
 *   .elicits({
 *     pickFlight: z.object({ flightId: z.string() }),
 *     confirm: z.object({ ok: z.boolean() }),
 *   })
 *   .execute(function* (params, ctx) {
 *     const picked = yield* ctx.elicit('pickFlight', { message: 'Pick a flight' })
 *     const ok = yield* ctx.elicit('confirm', { message: 'Confirm?' })
 *     return { picked, ok }
 *   })
 *
 * // Derive the plugin with exhaustive UI handlers
 * export const bookFlightPlugin = makePlugin(bookFlight)
 *   .onElicit({
 *     pickFlight: function* (req, ctx) {
 *       const { flightId } = yield* ctx.render(FlightPicker, {
 *         flights: req.flights,
 *         message: req.message,
 *       })
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
 * @example Register on server and client
 * ```typescript
 * // Server
 * import { bookFlightPlugin } from './bookFlightPlugin'
 * registerTools(bookFlightPlugin.server.tools)
 *
 * // Client
 * import { bookFlightPlugin } from './bookFlightPlugin'
 * useChat({ plugins: [bookFlightPlugin.client] })
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from "effection";
import type { z } from "zod";
import type { ComponentTypeLike } from "../browser-rendering/emissions.ts";
import type {
  ElicitRequest,
  ElicitsMap,
  ExtractElicitResponse,
  RawElicitResult,
} from "./mcp-tool-types.ts";
import type { ElicitDefinition } from "@sweatpants/elicit-context";
import type { SamplesMap } from "@sweatpants/core";
import type { McpRuntimeTool } from "./mcp-runtime-tool.ts";

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
 *
 * This context provides:
 * - `render(Component, props)` for React component rendering (matching BrowserRenderContext)
 * - `elicitRequest` with the current elicitation request data
 * - `reportProgress(message)` for progress updates
 */
export interface PluginClientContext<TElicitRequest = ElicitRequest<string, z.ZodType>> {
  /** Tool call ID */
  callId: string;

  /** Abort signal for cancellation */
  signal: AbortSignal;

  /** The current elicitation request */
  elicitRequest: TElicitRequest;

  /**
   * Render a React component and wait for user response.
   *
   * The component will be rendered in the chat timeline. When the user
   * interacts (e.g., clicks a button), the component calls `onRespond(value)`
   * and this operation resumes with that value.
   *
   * For "fire-and-forget" components (e.g., loading indicators), the component
   * should call `onRespond()` immediately in useEffect.
   *
   * @param Component - React component to render
   * @param props - Props for the component (without RenderableProps)
   * @returns Response from the component
   *
   * @example
   * ```typescript
   * // Wait for user to pick an option
   * const { flightId } = yield* ctx.render(FlightPicker, {
   *   flights: req.flights,
   *   message: req.message,
   * })
   * ```
   */
  render<TProps, TResponse = ExtractResponse<TProps>>(
    Component: ComponentTypeLike<TProps>,
    props: UserProps<TProps>,
  ): Operation<TResponse>;

  /**
   * Report progress to the UI.
   */
  reportProgress?(message: string): Operation<void>;
}

// =============================================================================
// ELICIT HANDLER TYPES
// =============================================================================

/**
 * Handler function for a single elicitation key.
 *
 * The handler is a generator that receives the elicitation request
 * and client context, and returns an ElicitResult.
 *
 * @template TKey - The elicitation key name
 * @template TDef - ElicitDefinition for this elicitation key
 */
export type ElicitHandler<TKey extends string, TDef extends ElicitDefinition> = (
  // Use `any` for schema type to avoid Zod v3/v4 incompatibility issues
  // The actual response type is correctly inferred from the definition
  req: ElicitRequest<TKey, any>,
  ctx: PluginClientContext<ElicitRequest<TKey, any>>,
) => Operation<RawElicitResult<ExtractElicitResponse<TDef>>>;

/**
 * Map of elicitation handlers for all keys in a tool.
 *
 * This is an exhaustive map - every key declared in `.elicits()`
 * must have a corresponding handler.
 *
 * @template TElicits - The tool's elicitation map
 */
export type ElicitHandlers<TElicits extends ElicitsMap> = {
  [K in keyof TElicits & string]: ElicitHandler<K, TElicits[K]>;
};

// =============================================================================
// PLUGIN TYPES
// =============================================================================

/**
 * Server-side registration for a plugin.
 */
export interface PluginServerRegistration<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
> {
  /** Tools to register with the chat handler */
  tools: [McpRuntimeTool<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>];

  /** Tool name (for lookup) */
  toolName: TName;
}

/**
 * Client-side registration for a plugin.
 */
export interface PluginClientRegistration<TElicits extends ElicitsMap> {
  /** Tool name (for matching incoming elicitation requests) */
  toolName: string;

  /** Elicitation handlers (exhaustive map) */
  handlers: ElicitHandlers<TElicits>;

  /** Elicitation schemas (for validation) */
  schemas: TElicits;
}

/**
 * A complete plugin derived from a bridgeable MCP tool.
 */
export interface McpPlugin<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined = undefined,
> {
  /** Server-side registration */
  server: PluginServerRegistration<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>;

  /** Client-side registration */
  client: PluginClientRegistration<TElicits>;

  /** Original tool (for advanced use cases) */
  tool: McpRuntimeTool<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>;
}

// =============================================================================
// PLUGIN BUILDER
// =============================================================================

/**
 * Builder for creating a plugin from a bridgeable tool.
 */
export interface PluginBuilder<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
> {
  /**
   * Define exhaustive handlers for all elicitation keys.
   *
   * Each handler is a generator that receives:
   * - `req`: The elicitation request (message, schema, context data, etc.)
   * - `ctx`: Client context (step, waitFor, reportProgress, etc.)
   *
   * And returns an `ElicitResult<T>`:
   * - `{ action: 'accept', content: T }` - User submitted data
   * - `{ action: 'decline' }` - User declined
   * - `{ action: 'cancel' }` - User cancelled
   *
   * @example
   * ```typescript
   * .onElicit({
   *   pickFlight: function* (req, ctx) {
   *     const { flightId } = yield* ctx.render(FlightPicker, {
   *       flights: req.flights,
   *       message: req.message,
   *     })
   *     return { action: 'accept', content: { flightId } }
   *   },
   *   confirm: function* (req, ctx) {
   *     const { ok } = yield* ctx.render(Confirm, { message: req.message })
   *     return { action: ok ? 'accept' : 'decline', content: { ok } }
   *   },
   * })
   * ```
   */
  onElicit(
    handlers: ElicitHandlers<TElicits>,
  ): PluginBuilderWithHandlers<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>;
}

/**
 * Builder after handlers are defined - ready to build.
 */
export interface PluginBuilderWithHandlers<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
> {
  /**
   * Build the final plugin.
   *
   * @returns A plugin with `server` and `client` registrations
   */
  build(): McpPlugin<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>;
}

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface PluginBuilderState<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
> {
  tool: McpRuntimeTool<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>;
  handlers?: ElicitHandlers<TElicits>;
}

function createPluginBuilder<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
>(
  state: PluginBuilderState<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>,
): PluginBuilder<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples> {
  return {
    onElicit(handlers: ElicitHandlers<TElicits>) {
      return {
        build(): McpPlugin<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples> {
          const { tool } = state;

          return {
            tool,

            server: {
              tools: [tool],
              toolName: tool.name,
            },

            client: {
              toolName: tool.name,
              handlers,
              schemas: tool.elicits as TElicits,
            },
          };
        },
      };
    },
  };
}

/**
 * Create a plugin from a bridgeable MCP tool.
 *
 * The tool must have been created with `.elicits({...})` to declare
 * its elicitation surface. The returned builder requires you to
 * implement handlers for every declared elicitation key.
 *
 * @param tool - A bridgeable tool (created with `.elicits()`)
 * @returns A builder for defining elicitation handlers
 *
 * @example
 * ```typescript
 * const plugin = makePlugin(bookFlight)
 *   .onElicit({
 *     pickFlight: function* (req, ctx) { ... },
 *     confirm: function* (req, ctx) { ... },
 *   })
 *   .build()
 * ```
 */
export function makePlugin<
  TName extends string,
  TParams,
  TInteraction,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
  TSamples extends SamplesMap | true | undefined,
>(
  tool: McpRuntimeTool<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples>,
): PluginBuilder<TName, TParams, TInteraction, TClient, TResult, TElicits, TSamples> {
  return createPluginBuilder({ tool });
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the elicits map from a plugin.
 */
export type InferElicits<T> = T extends McpPlugin<any, any, any, any, any, infer E, any> ? E : never;

/**
 * Extract the tool type from a plugin.
 */
export type InferPluginTool<T> =
  T extends McpPlugin<infer N, infer P, infer H, infer C, infer R, infer E, infer S>
    ? McpRuntimeTool<N, P, H, C, R, E, S>
    : never;

/**
 * Any plugin (for arrays/registries).
 */
export type AnyMcpPlugin = McpPlugin<string, any, any, any, any, ElicitsMap, any>;

/**
 * Structural type for accepting full plugin handles in arrays.
 *
 * This is the handle-based API: `useChat` receives concrete plugin objects
 * (the return value of `makePlugin(tool).onElicit({...}).build()`) and derives
 * both the client-side elicitation handlers and the server-side `enabledPlugins`
 * list from them.
 *
 * Each `McpPlugin<...>` satisfies this interface, allowing heterogeneous
 * plugins with different elicit maps to be collected.
 */
export interface PluginHandleInput {
  /** The tool definition */
  tool: unknown;
  /** Server-side registration */
  server: { tools: unknown[]; toolName: string };
  /** Client-side registration (handlers + tool name) */
  client: PluginClientRegistrationInput;
}

/**
 * Structural type for accepting plugin client registrations in arrays.
 *
 * This type uses structural compatibility rather than generic constraints,
 * allowing heterogeneous plugins with different elicit maps to be collected.
 * Each `PluginClientRegistration<TElicits>` satisfies this interface.
 *
 * The handlers signature uses `never` for parameters (bivariant function compatibility)
 * and `unknown` for return, allowing any specific handler to be assigned.
 */
export interface PluginClientRegistrationInput {
  toolName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: Record<string, (req: any, ctx: any) => Operation<RawElicitResult<unknown>>>;
  schemas: ElicitsMap;
}
