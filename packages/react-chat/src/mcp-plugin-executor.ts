/**
 * Plugin Executor
 *
 * Executes plugin elicitation handlers with the PluginClientContext.
 * Wires up the emission runtime for `ctx.render()` calls.
 *
 * ## Usage
 *
 * ```typescript
 * // In durable chat execution when handling an elicit event
 * const ctx = createPluginClientContext({
 *   callId: event.request.callId,
 *   toolName: 'book_flight',
 *   elicitRequest: event.request,
 *   runtime,
 *   signal,
 * })
 *
 * const result = yield* executePluginElicitHandler(plugin, 'pickFlight', event.request, ctx)
 * event.responseSignal.send(result)
 * ```
 */
import type { Operation, Channel } from "effection";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { ElicitRequest, WireElicitResult } from "@sweatpants/tool-session/mcp";
import type {
  ExtractResponse,
  PluginClientContext,
  PluginClientRegistration,
  UserProps,
} from "@sweatpants/tool-session/mcp";
import {
  type RuntimePrimitive,
  type ComponentEmissionPayload,
  type PendingEmission,
  type ComponentTypeLike,
  COMPONENT_EMISSION_TYPE,
  getComponentKey,
  createRuntime,
  createComponentHandler,
} from "@sweatpants/chat-core";

// =============================================================================
// CONTEXT CREATION
// =============================================================================

/**
 * Options for creating a PluginClientContext.
 */
export interface CreatePluginClientContextOptions<
  TElicitRequest = ElicitRequest<string, StandardSchemaV1>,
> {
  /** Tool call ID */
  callId: string;

  /** Tool name */
  toolName: string;

  /** The current elicitation request */
  elicitRequest: TElicitRequest;

  /** Emission runtime for ctx.render() - if not provided, a channel must be given */
  runtime?: RuntimePrimitive;

  /** Channel for emissions (used to create runtime if not provided) */
  emissionChannel?: Channel<PendingEmission<ComponentEmissionPayload, unknown>, void>;

  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Create a PluginClientContext for executing elicitation handlers.
 *
 * The context provides:
 * - `render(Component, props)` - Render React component and wait for response
 * - `elicitRequest` - The current elicitation request data
 * - `reportProgress(message)` - Report progress (optional)
 *
 * @param options - Context options
 * @returns PluginClientContext ready for use in handlers
 */
export function createPluginClientContext<TElicitRequest = ElicitRequest<string, StandardSchemaV1>>(
  options: CreatePluginClientContextOptions<TElicitRequest>,
): PluginClientContext<TElicitRequest> {
  const { callId, elicitRequest, signal = new AbortController().signal } = options;

  // Get or create the runtime
  let runtime = options.runtime;
  if (!runtime && options.emissionChannel) {
    runtime = createRuntime(
      {
        handlers: {
          [COMPONENT_EMISSION_TYPE]: createComponentHandler(options.emissionChannel),
        },
        emissionChannel: options.emissionChannel,
        fallback: "error",
      },
      `${callId}-plugin`,
    );
  }

  if (!runtime) {
    throw new Error("Either runtime or emissionChannel must be provided");
  }

  // Capture as const after the guard so TS can narrow in closures below
  const resolvedRuntime = runtime;

  const ctx: PluginClientContext<TElicitRequest> = {
    callId,
    signal,
    elicitRequest,

    // render() implementation using emission runtime
    *render<TProps, TResponse = ExtractResponse<TProps>>(
      Component: ComponentTypeLike,
      props: UserProps<TProps>,
    ): Operation<TResponse> {
      const componentKey = getComponentKey(Component);

      const payload: ComponentEmissionPayload = {
        componentKey,
        props: props as Record<string, unknown>,
        _component: Component,
      };

      // Emit and wait for response
      return yield* resolvedRuntime.emit<ComponentEmissionPayload, TResponse>(
        COMPONENT_EMISSION_TYPE,
        payload,
      );
    },

    // Optional reportProgress - no-op by default
    *reportProgress(_message: string): Operation<void> {
      // Can be overridden if needed
      // For now, this is a no-op
    },
  };

  return ctx;
}

// =============================================================================
// HANDLER EXECUTION
// =============================================================================

/**
 * Execute a plugin's elicitation handler for a given key.
 *
 * This looks up the handler in the plugin's handlers map and executes it
 * with the elicitation request and client context.
 *
 * @param plugin - The plugin client registration
 * @param key - The elicitation key to handle
 * @param request - The elicitation request
 * @param ctx - The plugin client context
 * @returns The handler result
 */
export function* executeElicitHandler<
  TNormalized extends Record<string, unknown>,
  K extends keyof TNormalized & string,
>(
  plugin: PluginClientRegistration<TNormalized>,
  key: K,
  // Use `any` for schema type to avoid Zod v3/v4 incompatibility issues
  request: ElicitRequest<K, StandardSchemaV1>,
  ctx: PluginClientContext<ElicitRequest<K, StandardSchemaV1>>,
): Operation<WireElicitResult<unknown>> {
  const handler = plugin.handlers[key];

  if (!handler) {
    throw new Error(
      `Plugin "${plugin.toolName}" has no handler for elicitation key "${key}". ` +
        `Available keys: ${Object.keys(plugin.handlers).join(", ")}`,
    );
  }

  // Execute the handler
  return yield* handler(request, ctx);
}

/**
 * Execute a plugin's elicitation handler by looking up the key from the request.
 *
 * This is a convenience wrapper that extracts the key from the request.
 *
 * @param plugin - The plugin client registration
 * @param request - The elicitation request (must have a `key` field)
 * @param ctx - The plugin client context
 * @returns The handler result
 */
export function* executeElicitHandlerFromRequest<TNormalized extends Record<string, unknown>>(
  plugin: PluginClientRegistration<TNormalized>,
  request: ElicitRequest<string, StandardSchemaV1>,
  ctx: PluginClientContext,
): Operation<WireElicitResult<unknown>> {
  const key = request.key as keyof TNormalized & string;

  if (!(key in plugin.handlers)) {
    throw new Error(
      `Plugin "${plugin.toolName}" has no handler for elicitation key "${key}". ` +
        `Available keys: ${Object.keys(plugin.handlers).join(", ")}`,
    );
  }

  // Heterogeneous handler map: narrow through the map's own value type.
  const handler = plugin.handlers[key] as (
    req: ElicitRequest<string, StandardSchemaV1>,
    hctx: PluginClientContext,
  ) => Operation<WireElicitResult<unknown>>;
  return yield* handler(request, ctx);
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Infer the context type for a specific elicitation key.
 * Uses `any` for schema type to avoid Zod v3/v4 incompatibility issues.
 */
export type PluginContextForKey<
  TElicits extends Record<string, unknown>,
  K extends keyof TElicits & string,
> = PluginClientContext<ElicitRequest<K, any>>;
