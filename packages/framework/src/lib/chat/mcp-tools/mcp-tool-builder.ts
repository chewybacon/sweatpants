/**
 * MCP Tool Builder
 *
 * Type-safe builder for creating MCP tools with:
 * - Sub-branching for structured concurrency
 * - LLM backchannel (sampling)
 * - User backchannel (elicitation)
 * - Optional keyed elicitation for UI bridging
 *
 * ## Usage
 *
 * @example Simple tool (no handoff)
 * ```typescript
 * const calculator = createMcpTool('calculate')
 *   .description('Perform a calculation')
 *   .parameters(z.object({ expression: z.string() }))
 *   .execute(function*(params, ctx) {
 *     const result = yield* ctx.sample({ prompt: `Calculate: ${params.expression}` })
 *     return result.text
 *   })
 * ```
 *
 * @example Tool with handoff (multi-turn, sub-branches)
 * ```typescript
 * const bookFlight = createMcpTool('book_flight')
 *   .description('Book a flight with analysis and confirmation')
 *   .parameters(z.object({ destination: z.string() }))
 *   .requires({ elicitation: true, sampling: true })
 *   .handoff({
 *     *before(params, ctx) {
 *       const flights = yield* searchFlights(params.destination)
 *       return { flights }
 *     },
 *     *client(handoff, ctx) {
 *       // Auto-tracked conversation
 *       const analysis = yield* ctx.sample({
 *         prompt: `Analyze these flights: ${JSON.stringify(handoff.flights)}`
 *       })
 *
 *       // Sub-branch for price verification
 *       const priceCheck = yield* ctx.branch(function* (subCtx) {
 *         return yield* subCtx.sample({ prompt: 'Verify current prices...' })
 *       }, { inheritMessages: false })
 *
 *       // User confirmation
 *       const choice = yield* ctx.elicit({
 *         message: `Book ${analysis.text}?`,
 *         schema: z.object({ confirm: z.boolean() })
 *       })
 *
 *       if (choice.action !== 'accept' || !choice.content.confirm) {
 *         return { cancelled: true }
 *       }
 *
 *       return { flightId: handoff.flights[0].id, analysis: analysis.text }
 *     },
 *     *after(handoff, client, ctx, params) {
 *       if (client.cancelled) return 'Booking cancelled'
 *       return `Booked flight ${client.flightId}`
 *     },
 *   })
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from "effection";
import type { z } from "zod";
import type {
  McpToolContext,
  McpToolContextWithElicits,
  McpToolHandoffConfig,
  McpToolHandoffConfigWithElicits,
  McpToolLimits,
  ElicitsMap,
  LogLevel,
} from "./mcp-tool-types.ts";

// =============================================================================
// UNIFIED TOOL CALLABLE SHAPE
// =============================================================================

export interface UnifiedToolCtxShape<TElicits extends ElicitsMap = ElicitsMap> {
  history?: unknown[];
  elicit<K extends keyof TElicits & string>(key: K, options: { message: string } & Record<string, unknown>): Operation<{
    action?: "accept" | "decline" | "cancel";
    content?: unknown;
    exchange?: unknown;
    status?: "accepted" | "declined" | "cancelled";
    value?: unknown;
    reason?: string;
  }>;
  elicitDynamic?(options: { key: string; message: string; responseSchema?: unknown; contextSchema?: unknown; context?: unknown }): Operation<{
    action?: "accept" | "decline" | "cancel";
    content?: unknown;
    exchange?: unknown;
    status?: "accepted" | "declined" | "cancelled";
    value?: unknown;
    reason?: string;
  }>;
  sample<TParsed = undefined>(options: Record<string, unknown>): Operation<{ content: string; parsed?: TParsed; exchange?: unknown; parseError?: string }>;
  notify(message: string, fraction?: number, level?: LogLevel): Operation<void>;
  log?(level: LogLevel, message: string): Operation<void>;
}

export type UnifiedCallable<I = unknown, O = unknown, TElicits extends ElicitsMap = ElicitsMap> = {
  (ctx: UnifiedToolCtxShape<TElicits>): Operation<(input: I) => Operation<O>>;
};

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 */
export interface McpToolTypes<in out TParams, in out THandoff, in out TClient, in out TResult> {
  params: TParams;
  handoff: THandoff;
  client: TClient;
  result: TResult;
}

// =============================================================================
// BUILDER INTERFACES
// =============================================================================

/**
 * Base builder - has name, needs everything else.
 */
export interface McpToolBuilderBase<TName extends string> {
  _types: McpToolTypes<undefined, undefined, undefined, undefined>;
  _name: TName;

  /** Set the description shown to the LLM */
  description(desc: string): McpToolBuilderWithDescription<TName>;
}

/**
 * Has name + description, needs parameters.
 */
export interface McpToolBuilderWithDescription<TName extends string> {
  _types: McpToolTypes<undefined, undefined, undefined, undefined>;
  _name: TName;
  _description: string;

  /** Set the Zod schema for tool parameters */
  parameters<TSchema extends z.ZodType>(
    schema: TSchema,
  ): McpToolBuilderWithParams<TName, z.infer<TSchema>>;
}

/**
 * Has name + description + params. Must call `.elicits()` next.
 *
 * All MCP tools must declare their elicitation surface, even if empty.
 * This ensures type-safe `ctx.elicit()` calls and enables plugin detection.
 */
export interface McpToolBuilderWithParams<TName extends string, TParams> {
  _types: McpToolTypes<TParams, undefined, undefined, undefined>;
  _name: TName;
  _description: string;
  _parameters: z.ZodType<TParams>;

  /**
   * Declare required MCP client capabilities.
   * Tool won't be listed if client doesn't have these.
   */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): this;

  /**
   * Set default limits for branch execution.
   * Can be overridden at runtime or per-branch.
   */
  limits(limits: McpToolLimits): this;

  /**
   * Declare the elicitation surface for type-safe UI bridging.
   *
   * **This is required** - all MCP tools must call `.elicits()`.
   * For tools that don't need elicitation, pass an empty object: `.elicits({})`.
   *
   * When you call `.elicits({...})`, the tool becomes "bridgeable":
   * - `ctx.elicit` becomes keyed: `ctx.elicit('pickFlight', { message: '...' })`
   * - The derived plugin must implement handlers for every key (exhaustive)
   * - Type safety is guaranteed across server/client boundary
   *
   * @example
   * ```typescript
   * // Tool with elicitation
   * const tool = createMcpTool('book_flight')
   *   .description('Book a flight')
   *   .parameters(z.object({ destination: z.string() }))
   *   .elicits({
   *     pickFlight: z.object({ flightId: z.string() }),
   *     confirm: z.object({ ok: z.boolean() }),
   *   })
   *   .execute(function* (params, ctx) {
   *     const picked = yield* ctx.elicit('pickFlight', { message: 'Pick' })
   *     // ...
   *   })
   *
   * // Tool without elicitation (still must call .elicits())
   * const calculator = createMcpTool('calculate')
   *   .description('Do math')
   *   .parameters(z.object({ expr: z.string() }))
   *   .elicits({})  // Empty - no elicitation needed
   *   .execute(function* (params, ctx) {
   *     const result = yield* ctx.sample({ prompt: params.expr })
   *     return result.text
   *   })
   * ```
   */
  elicits<TElicits extends ElicitsMap>(
    schemas: TElicits,
  ): McpToolBuilderWithElicits<TName, TParams, TElicits>;
}

/**
 * Has name + description + params + elicits, can set requires/limits or define execution.
 */
export interface McpToolBuilderWithElicits<
  TName extends string,
  TParams,
  TElicits extends ElicitsMap,
> {
  _types: McpToolTypes<TParams, undefined, undefined, undefined>;
  _name: TName;
  _description: string;
  _parameters: z.ZodType<TParams>;
  _elicits: TElicits;

  /**
   * Declare required MCP client capabilities.
   */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): this;

  /**
   * Set default limits for branch execution.
   */
  limits(limits: McpToolLimits): this;

  /**
   * Define a simple execute function with keyed elicitation.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: McpToolContextWithElicits<TElicits>) => Operation<TResult>,
  ): McpRuntimeTool<TName, TParams, undefined, undefined, TResult, TElicits>;

  /**
   * Define handoff pattern with keyed elicitation.
   */
  handoff<THandoff, TClient, TResult>(
    config: McpToolHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>,
  ): McpRuntimeTool<TName, TParams, THandoff, TClient, TResult, TElicits>;
}

// =============================================================================
// RUNTIME TOOL
// =============================================================================

/**
 * A fully configured MCP tool.
 */
/**
 * @deprecated Use `McpRuntimeTool` for runtime consumers. This compatibility
 * view remains for type inference during migration.
 */
export interface McpRuntimeToolShape<TName extends string, TParams, THandoff, TClient, TResult> {
  /** Unified callable runtime activation. */
  (ctx: UnifiedToolCtxShape): Operation<(input: TParams) => Operation<TResult>>;

  /** Phantom type carrier */
  _types: McpToolTypes<TParams, THandoff, TClient, TResult>;

  /** Tool name (used by LLM) */
  name: TName;

  /** Description (shown to LLM) */
  description: string;

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>;

  /** Required MCP capabilities */
  requires?: { elicitation?: boolean; sampling?: boolean };

  /** Default limits for branch execution */
  limits?: McpToolLimits;

  /** Handoff config (if using handoff pattern) */
  handoffConfig?: McpToolHandoffConfig<TParams, THandoff, TClient, TResult>;

  /** Execute function (if not using handoff) */
  execute?: (params: TParams, ctx: McpToolContext) => Operation<TResult>;

  /** Unified tool schemas for projection/runtime consumers. */
  schemas?: { input: unknown; output?: unknown };

  /** Unified tool capabilities for projection/runtime consumers. */
  capabilities?: { elicitation?: boolean; sampling?: boolean };
}

/**
 * A fully configured MCP tool with keyed elicitation.
 *
 * This tool is "bridgeable" - it can be derived into a plugin with
 * exhaustive, type-safe UI handlers for each elicitation key.
 */
/**
 * @deprecated Use `McpRuntimeTool` for runtime consumers. This compatibility
 * view remains for type inference during migration.
 */
export interface McpRuntimeToolShapeWithElicits<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
> {
  /** Unified callable runtime activation. */
  (ctx: UnifiedToolCtxShape<TElicits>): Operation<(input: TParams) => Operation<TResult>>;

  /** Phantom type carrier */
  _types: McpToolTypes<TParams, THandoff, TClient, TResult>;

  /** Tool name (used by LLM) */
  name: TName;

  /** Description (shown to LLM) */
  description: string;

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>;

  /** Elicitation schemas map (finite surface for UI bridging) */
  elicits: TElicits;

  /** Required MCP capabilities */
  requires?: { elicitation?: boolean; sampling?: boolean };

  /** Default limits for branch execution */
  limits?: McpToolLimits;

  /** Handoff config with keyed elicitation */
  handoffConfig?: McpToolHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>;

  /** Execute function with keyed elicitation */
  execute?: (params: TParams, ctx: McpToolContextWithElicits<TElicits>) => Operation<TResult>;

  /** Unified tool schemas for projection/runtime consumers. */
  schemas?: { input: unknown; output?: unknown };

  /** Unified tool capabilities for projection/runtime consumers. */
  capabilities?: { elicitation?: boolean; sampling?: boolean };
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the result type from a runtime tool.
 */
export type InferMcpToolResult<T> =
  T extends McpRuntimeToolShape<any, any, any, any, infer R> ? R : never;

/**
 * Extract the params type from a runtime tool.
 */
export type InferMcpToolParams<T> =
  T extends McpRuntimeToolShape<any, infer P, any, any, any> ? P : never;

/**
 * Extract the handoff type from a runtime tool.
 */
export type InferMcpToolHandoff<T> =
  T extends McpRuntimeToolShape<any, any, infer H, any, any> ? H : never;

/**
 * Extract the client output type from a runtime tool.
 */
export type InferMcpToolClient<T> =
  T extends McpRuntimeToolShape<any, any, any, infer C, any> ? C : never;

/**
 * Any MCP tool (for arrays/registries).
 */
export type AnyMcpTool = McpRuntimeToolShape<string, any, any, any, any>;

/**
 * Any bridgeable MCP tool (has `.elicits()`).
 */
export type AnyBridgeableMcpTool = McpRuntimeToolShapeWithElicits<
  string,
  any,
  any,
  any,
  any,
  ElicitsMap
>;

/**
 * Extract the elicits map from a bridgeable tool.
 */
export type InferMcpToolElicits<T> =
  T extends McpRuntimeToolShapeWithElicits<any, any, any, any, any, infer E> ? E : never;

/**
 * Neutral MCP-compatible runtime tool shape.
 *
 * This is the public runtime type new consumers should use. The older
 * `McpRuntimeToolShape*` names remain as compatibility views while package
 * consumers migrate, but they are not a distinct terminal runtime model.
 */
export type McpRuntimeTool<
  TName extends string = string,
  TParams = unknown,
  THandoff = unknown,
  TClient = unknown,
  TResult = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
> = McpRuntimeToolShapeWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits> &
  UnifiedCallable<TParams, TResult, TElicits>;

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface BuilderState {
  name: string;
  description?: string;
  parameters?: z.ZodType;
  elicits?: ElicitsMap;
  requires?: { elicitation?: boolean; sampling?: boolean };
  limits?: McpToolLimits;
  handoffConfig?: McpToolHandoffConfigWithElicits<any, any, any, any, any>;
  executeFn?: (params: any, ctx: McpToolContext) => Operation<any>;
}

function makeServerCtx() {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    signal: new AbortController().signal,
  };
}

function normalizeElicitAction(res: { action?: string; status?: string }) {
  return res.action ?? (res.status === "accepted" ? "accept" : res.status === "declined" ? "decline" : "cancel");
}

function shimMcpToolCtx<TElicits extends ElicitsMap>(ctx: UnifiedToolCtxShape<TElicits>): McpToolContextWithElicits<TElicits> {
  const mcpCtx = {
    parentMessages: [],
    parentSystemPrompt: undefined,
    messages: [],
    depth: 0,
    sample(config: Record<string, unknown>): Operation<any> {
      return (function* (): Operation<any> {
        const res = yield* ctx.sample(config);
        return {
          text: res.content,
          content: res.content,
          parsed: res.parsed ?? undefined,
          parseError: res.parseError,
          stopReason: "endTurn",
          exchange: res.exchange,
        };
      })();
    },
    sampleTools(_config: unknown): Operation<any> {
      return (function* (): Operation<any> {
        throw new Error("sampleTools is not supported by the unified agents runtime shim yet; use ctx.sample({ tools }) through the framework MCP runtime.");
      })();
    },
    sampleSchema(config: Record<string, unknown>): Operation<any> {
      return (function* (): Operation<any> {
        const res = yield* ctx.sample(config);
        if (res.parsed === undefined) {
          throw new Error(res.parseError ?? "sampleSchema failed to produce parsed output");
        }
        return { text: res.content, content: res.content, parsed: res.parsed, exchange: res.exchange };
      })();
    },
    elicit(key: string, options: { message: string } & Record<string, unknown>): Operation<any> {
      return (function* (): Operation<any> {
        const res = yield* ctx.elicit(key as keyof TElicits & string, options as never);
        const action = normalizeElicitAction(res);
        if (action === "accept") {
          return {
            action: "accept",
            status: "accepted",
            content: (res as { content?: unknown; value?: unknown }).content ?? (res as { value?: unknown }).value,
            value: (res as { value?: unknown; content?: unknown }).value ?? (res as { content?: unknown }).content,
            exchange: (res as { exchange?: unknown }).exchange,
          };
        }
        return { action, status: action === "decline" ? "declined" : "cancelled", reason: (res as { reason?: string }).reason };
      })();
    },
    branch<T>(fn: (branchCtx: McpToolContextWithElicits<TElicits>) => Operation<T>): Operation<T> {
      return fn(mcpCtx as unknown as McpToolContextWithElicits<TElicits>);
    },
    log(level: LogLevel, message: string): Operation<void> {
      return ctx.log ? ctx.log(level, message) : ctx.notify(message, undefined, level);
    },
    notify(message: string, progress?: number): Operation<void> {
      return ctx.notify(message, progress);
    },
  };
  return mcpCtx as unknown as McpToolContextWithElicits<TElicits>;
}

function makeUnifiedCallable<I, O, TElicits extends ElicitsMap>(meta: {
  name: string;
  parameters: z.ZodType;
  execute?: (params: I, ctx: McpToolContextWithElicits<TElicits>) => Operation<O>;
  handoffConfig?: McpToolHandoffConfigWithElicits<I, unknown, unknown, O, TElicits>;
}): UnifiedCallable<I, O, TElicits> {
  const activate = function (ctx: UnifiedToolCtxShape<TElicits>): Operation<(input: I) => Operation<O>> {
    return {
      *[Symbol.iterator]() {
        const toolCtx = shimMcpToolCtx(ctx);
        const serverCtx = makeServerCtx();
        const invoke = (input: I): Operation<O> =>
          (function* (): Operation<O> {
            const parsed = meta.parameters.safeParse(input);
            if (!parsed.success || parsed.data === undefined) {
              throw new Error(`Invalid params for tool "${meta.name}": ${parsed.error?.message ?? "validation failed"}`);
            }
            const params = parsed.data as I;
            if (meta.handoffConfig) {
              const { before, client, after } = meta.handoffConfig;
              const handoff = yield* before(params, serverCtx as never);
              const clientResult = yield* client(handoff, toolCtx);
              return yield* after(handoff, clientResult, serverCtx as never, params);
            }
            if (meta.execute) {
              return yield* meta.execute(params, toolCtx);
            }
            throw new Error(`Tool "${meta.name}" has no execute or handoffConfig`);
          })();
        return invoke;
      },
    };
  };
  return activate as UnifiedCallable<I, O, TElicits>;
}

function attachUnifiedMetadata<T extends Function>(callable: T, meta: Record<string, unknown>): T & Record<string, unknown> {
  const descriptors: PropertyDescriptorMap = {};
  for (const [key, value] of Object.entries(meta)) {
    descriptors[key] = { value, enumerable: true, writable: true, configurable: true };
  }
  Object.defineProperties(callable, descriptors);
  return callable as T & Record<string, unknown>;
}

function createBuilder(state: BuilderState): any {
  const builder = {
    _types: undefined as any,
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,
    _elicits: state.elicits,

    description(desc: string) {
      return createBuilder({ ...state, description: desc });
    },

    parameters(schema: z.ZodType) {
      return createBuilder({ ...state, parameters: schema });
    },

    elicits(schemas: ElicitsMap) {
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .elicits()`);
      }
      return createBuilder({ ...state, elicits: schemas });
    },

    requires(caps: { elicitation?: boolean; sampling?: boolean }) {
      return createBuilder({ ...state, requires: caps });
    },

    limits(limits: McpToolLimits) {
      return createBuilder({ ...state, limits });
    },

    execute(fn: (params: any, ctx: any) => Operation<any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .execute()`);
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .execute()`);
      }
      if (!state.elicits) {
        throw new Error(
          `Tool "${state.name}": .elicits() must be called before .execute(). Use .elicits({}) if no elicitation is needed.`,
        );
      }

      const callable = makeUnifiedCallable<any, any, any>({
        name: state.name,
        parameters: state.parameters,
        execute: fn,
      });
      return attachUnifiedMetadata(callable, {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        elicits: state.elicits,
        requires: state.requires,
        limits: state.limits,
        execute: fn,
        schemas: { input: state.parameters, output: undefined },
        capabilities: state.requires ?? { elicitation: Object.keys(state.elicits).length > 0, sampling: false },
      }) as unknown as McpRuntimeTool<any, any, undefined, undefined, any, any>;
    },

    handoff(config: McpToolHandoffConfigWithElicits<any, any, any, any, any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .handoff()`);
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .handoff()`);
      }
      if (!state.elicits) {
        throw new Error(
          `Tool "${state.name}": .elicits() must be called before .handoff(). Use .elicits({}) if no elicitation is needed.`,
        );
      }

      const callable = makeUnifiedCallable<any, any, any>({
        name: state.name,
        parameters: state.parameters,
        handoffConfig: config,
      });
      return attachUnifiedMetadata(callable, {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        elicits: state.elicits,
        requires: state.requires,
        limits: state.limits,
        handoffConfig: config,
        schemas: { input: state.parameters, output: undefined },
        capabilities: state.requires ?? { elicitation: true, sampling: true },
      }) as unknown as McpRuntimeTool<any, any, any, any, any, any>;
    },
  };

  return builder;
}

/**
 * Create a type-safe MCP tool using the builder pattern.
 *
 * @param name - Unique tool name (used by LLM to invoke). When omitted, the
 *   vite plugin derives the name from the export identifier at build time.
 *   When provided, the name is used as-is and is not rewritten.
 * @returns Builder for configuring the tool
 *
 * @example Name derived from export identifier (requires vite plugin)
 * ```typescript
 * export const myTool = createMcpTool()
 *   .description('Does something with branches')
 *   .parameters(z.object({ input: z.string() }))
 *   .execute(function*(params, ctx) { ... })
 * // tool.name === 'my' (after 'Tool' suffix is stripped by the vite plugin)
 * ```
 *
 * @example Explicit name override
 * ```typescript
 * export const myTool = createMcpTool('my_tool')
 *   .description('Does something with branches')
 *   .parameters(z.object({ input: z.string() }))
 *   .execute(function*(params, ctx) {
 *     // Use auto-tracked conversation
 *     const first = yield* ctx.sample({ prompt: 'First step...' })
 *
 *     // Spawn a sub-branch
 *     const detail = yield* ctx.branch(function* (subCtx) {
 *       return yield* subCtx.sample({ prompt: 'Detail...' })
 *     })
 *
 *     return { first: first.text, detail: detail.text }
 *   })
 * ```
 *
 * When called without an argument and without the vite plugin, the tool name
 * is an empty string placeholder. The vite plugin inserts the derived name at
 * build time.
 */
export function createMcpTool<TName extends string = string>(
  name?: TName,
): McpToolBuilderBase<TName> {
  return createBuilder({ name: name ?? ("" as string) }) as McpToolBuilderBase<TName>;
}
