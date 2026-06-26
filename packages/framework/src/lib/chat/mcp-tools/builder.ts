/**
 * MCP Tool Builder
 *
 * Type-safe builder for creating MCP tools with generator-based execution.
 *
 * ## Usage
 *
 * @example Simple tool (no handoff)
 * ```typescript
 * const calculator = createMCPTool('calculate')
 *   .description('Perform a calculation')
 *   .parameters(z.object({ expression: z.string() }))
 *   .execute(function*(params) {
 *     return { result: eval(params.expression) }
 *   })
 * ```
 *
 * @example Tool with handoff (multi-turn interaction)
 * ```typescript
 * const bookFlight = createMCPTool('book_flight')
 *   .description('Book a flight with user confirmation')
 *   .parameters(z.object({ destination: z.string() }))
 *   .requires({ elicitation: true, sampling: true })
 *   .handoff({
 *     *before(params, ctx) {
 *       const flights = yield* searchFlights(params.destination)
 *       return { flights }
 *     },
 *     *client(handoff, ctx) {
 *       const selection = yield* ctx.elicit({
 *         message: 'Pick a flight:',
 *         schema: z.object({ flightId: z.string() })
 *       })
 *       if (selection.action !== 'accept') {
 *         return { cancelled: true }
 *       }
 *       const summary = yield* ctx.sample({
 *         prompt: `Summarize flight ${selection.content.flightId}`
 *       })
 *       return { flightId: selection.content.flightId, summary }
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
import type { MCPClientContext, MCPHandoffConfig, ElicitConfig, SampleConfig, LogLevel } from "./types.ts";

// =============================================================================
// UNIFIED TOOL CTX (structural — no import from @sweatpants/agents)
// =============================================================================
//
// The finalized MCP tool is callable as a `UnifiedToolFactory`: `(ctx) =>
// Operation<(input) => Operation<out>>` where `ctx` is this structural shape.
// `@sweatpants/agents`' `ToolCtx` is structurally compatible, so `ctx.call`
// duck-types the finalized tool (by `capabilities`) and projects `AgentCtx`→
// `ToolCtx` at call time. No adapter (`adaptMCPTool`) needed.

export interface UnifiedToolCtxShape {
  elicit(key: string, request: { message: string; schema?: unknown }): Operation<{
    action?: "accept" | "decline" | "cancel"
    content?: unknown
    status?: "accepted" | "declined" | "cancelled"
    value?: unknown
    reason?: string
  }>
  elicitDynamic?(options: { key: string; message: string; responseSchema?: unknown }): Operation<{
    action?: "accept" | "decline" | "cancel"
    content?: unknown
    status?: "accepted" | "declined" | "cancelled"
    value?: unknown
    reason?: string
  }>
  sample(options: { prompt: string; maxTokens?: number; schema?: unknown }): Operation<{ content: string }>
  notify(message: string, fraction?: number): Operation<void>
  log?(level: LogLevel, message: string): Operation<void>
}

/** A finalized MCP tool is both the legacy metadata object AND a callable. */
export type UnifiedCallable<I = unknown, O = unknown> = {
  (ctx: UnifiedToolCtxShape): Operation<(input: I) => Operation<O>>
}

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 * Uses `in out` variance for bidirectional type flow.
 */
export interface MCPToolTypes<in out TParams, in out THandoff, in out TClient, in out TResult> {
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
export interface MCPToolBuilderBase<TName extends string> {
  _types: MCPToolTypes<undefined, undefined, undefined, undefined>;
  _name: TName;

  /** Set the description shown to the LLM */
  description(desc: string): MCPToolBuilderWithDescription<TName>;
}

/**
 * Has name + description, needs parameters.
 */
export interface MCPToolBuilderWithDescription<TName extends string> {
  _types: MCPToolTypes<undefined, undefined, undefined, undefined>;
  _name: TName;
  _description: string;

  /** Set the Zod schema for tool parameters */
  parameters<TSchema extends z.ZodType>(
    schema: TSchema,
  ): MCPToolBuilderWithParams<TName, z.infer<TSchema>>;
}

/**
 * Has name + description + params, can set requires or define execution.
 */
export interface MCPToolBuilderWithParams<TName extends string, TParams> {
  _types: MCPToolTypes<TParams, undefined, undefined, undefined>;
  _name: TName;
  _description: string;
  _parameters: z.ZodType<TParams>;

  /**
   * Declare required MCP client capabilities.
   * Tool won't be listed if client doesn't have these.
   */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): this;

  /**
   * Define a simple execute function (no handoff).
   * For tools that don't need the before/client/after pattern.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: MCPClientContext) => Operation<TResult>,
  ): FinalizedMCPTool<TName, TParams, undefined, undefined, TResult> & {
    (ctx: UnifiedToolCtxShape): Operation<(input: TParams) => Operation<TResult>>
  };

  /**
   * Define handoff pattern for multi-turn interaction.
   */
  handoff<THandoff, TClient, TResult>(
    config: MCPHandoffConfig<TParams, THandoff, TClient, TResult>,
  ): FinalizedMCPTool<TName, TParams, THandoff, TClient, TResult> & {
    (ctx: UnifiedToolCtxShape): Operation<(input: TParams) => Operation<TResult>>
  };
}

// =============================================================================
// FINALIZED TOOL
// =============================================================================

/**
 * A fully configured MCP tool.
 */
export interface FinalizedMCPTool<TName extends string, TParams, THandoff, TClient, TResult> {
  /** Phantom type carrier */
  _types: MCPToolTypes<TParams, THandoff, TClient, TResult>;

  /** Tool name (used by LLM) */
  name: TName;

  /** Description (shown to LLM) */
  description: string;

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>;

  /** Required MCP capabilities */
  requires?: { elicitation?: boolean; sampling?: boolean };

  /** Handoff config (if using handoff pattern) */
  handoffConfig?: MCPHandoffConfig<TParams, THandoff, TClient, TResult>;

  /** Execute function (if not using handoff) */
  execute?: (params: TParams, ctx: MCPClientContext) => Operation<TResult>;

  /** Unified tool schemas (attached by the builder for UnifiedToolFactory compat). */
  schemas?: { input: unknown; output: unknown };
  /** Unified tool capabilities (MCP `requires`; used for detection + projection). */
  capabilities?: { elicitation?: boolean; sampling?: boolean };
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the result type from a finalized tool.
 */
export type InferMCPResult<T> = T extends FinalizedMCPTool<any, any, any, any, infer R> ? R : never;

/**
 * Extract the params type from a finalized tool.
 */
export type InferMCPParams<T> = T extends FinalizedMCPTool<any, infer P, any, any, any> ? P : never;

/**
 * Extract the handoff type from a finalized tool.
 */
export type InferMCPHandoff<T> =
  T extends FinalizedMCPTool<any, any, infer H, any, any> ? H : never;

/**
 * Extract the client output type from a finalized tool.
 */
export type InferMCPClient<T> = T extends FinalizedMCPTool<any, any, any, infer C, any> ? C : never;

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface BuilderState {
  name: string;
  description?: string;
  parameters?: z.ZodType;
  requires?: { elicitation?: boolean; sampling?: boolean };
  handoffConfig?: MCPHandoffConfig<any, any, any, any>;
  executeFn?: (params: any, ctx: MCPClientContext) => Operation<any>;
}

// =============================================================================
// UNIFIED CALLABLE FACTORY — the finalized tool is callable as a UnifiedToolFactory
// =============================================================================

/** Shim a structural UnifiedToolCtxShape into the MCPClientContext the impls expect. */
function shimClientCtx(ctx: UnifiedToolCtxShape): MCPClientContext {
  return {
    elicit<T>(config: ElicitConfig<T>): Operation<any> {
      return (function* (): Operation<any> {
        const res = ctx.elicitDynamic
          ? yield* ctx.elicitDynamic({
              key: "elicit",
              message: config.message,
              responseSchema: config.schema,
            })
          : yield* ctx.elicit("elicit", {
              message: config.message,
              schema: config.schema,
            })
        const action = res.action ?? (res.status === "accepted" ? "accept" : res.status === "declined" ? "decline" : "cancel")
        if (action === "accept") {
          return { action: "accept", content: res.content ?? res.value, exchange: undefined }
        }
        return {
          action,
          reason: res.reason,
          content: undefined,
          exchange: undefined,
        }
      })()
    },
    sample<T = string>(config: SampleConfig<T>): Operation<T> {
      return (function* (): Operation<T> {
        const opts: { prompt: string; maxTokens?: number; schema?: unknown } = { prompt: config.prompt }
        if (config.maxTokens !== undefined) {
          opts.maxTokens = config.maxTokens
        }
        if (config.schema !== undefined) {
          opts.schema = config.schema
        }
        const res = yield* ctx.sample(opts)
        return res.content as T
      })()
    },
    log(level: LogLevel, message: string): Operation<void> {
      return ctx.log ? ctx.log(level, message) : ctx.notify(message)
    },
    notify(message: string, progress?: number): Operation<void> {
      return ctx.notify(message, progress)
    },
  } as unknown as MCPClientContext
}

/** Minimal server ctx for before/after. */
function makeServerCtx() {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    signal: new AbortController().signal,
  }
}

/**
 * Build the unified callable for a finalized MCP tool. The returned function is
 * `(ctx: UnifiedToolCtxShape) => Operation<(input) => Operation<out>>`. Legacy
 * metadata (name/description/parameters/requires/handoffConfig/execute) is
 * attached as properties so existing consumers (mock-runtime, MCP handler) keep
 * working.
 */
function makeUnifiedCallable<I, O>(meta: {
  name: string
  parameters: z.ZodType
  execute?: (params: I, ctx: MCPClientContext) => Operation<O>
  handoffConfig?: MCPHandoffConfig<I, unknown, unknown, O>
}): UnifiedCallable<I, O> {
  const activate = function (ctx: UnifiedToolCtxShape): Operation<(input: I) => Operation<O>> {
    return {
      *[Symbol.iterator]() {
        const clientCtx = shimClientCtx(ctx)
        const serverCtx = makeServerCtx()
        const invoke = (input: I): Operation<O> =>
          (function* (): Operation<O> {
            const parsed = meta.parameters.safeParse(input)
            if (!parsed.success || parsed.data === undefined) {
              throw new Error(
                `Invalid params for tool "${meta.name}": ${parsed.error?.message ?? "validation failed"}`,
              )
            }
            const params = parsed.data as I
            if (meta.handoffConfig) {
              const { before, client: clientFn, after } = meta.handoffConfig
              const handoff = yield* before(params, serverCtx as never)
              const clientResult = yield* clientFn(handoff, clientCtx)
              return yield* after(handoff, clientResult, serverCtx as never, params)
            }
            if (meta.execute) {
              return yield* meta.execute(params, clientCtx)
            }
            throw new Error(`Tool "${meta.name}" has no execute or handoffConfig`)
          })()
        return invoke
      },
    }
  }
  return activate as UnifiedCallable<I, O>
}

function createBuilder(state: BuilderState): any {
  const builder = {
    _types: undefined as any,
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,

    description(desc: string) {
      return createBuilder({ ...state, description: desc });
    },

    parameters(schema: z.ZodType) {
      return createBuilder({ ...state, parameters: schema });
    },

    requires(caps: { elicitation?: boolean; sampling?: boolean }) {
      return createBuilder({ ...state, requires: caps });
    },

    execute(fn: (params: any, ctx: MCPClientContext) => Operation<any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .execute()`);
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .execute()`);
      }

      const callable = makeUnifiedCallable<any, any>({
        name: state.name,
        parameters: state.parameters,
        execute: fn,
      });
      const finalized = callable as FinalizedMCPTool<any, any, undefined, undefined, any> & UnifiedCallable<any, any>;
      Object.defineProperties(finalized, {
        _types: { value: undefined as any, enumerable: true, writable: true, configurable: true },
        name: { value: state.name, enumerable: true, writable: true, configurable: true },
        description: { value: state.description, enumerable: true, writable: true, configurable: true },
        parameters: { value: state.parameters, enumerable: true, writable: true, configurable: true },
        requires: { value: state.requires, enumerable: true, writable: true, configurable: true },
        execute: { value: fn, enumerable: true, writable: true, configurable: true },
        schemas: { value: { input: state.parameters, output: undefined }, enumerable: true, writable: true, configurable: true },
        capabilities: { value: state.requires ?? { elicitation: false, sampling: false }, enumerable: true, writable: true, configurable: true },
      });
      return finalized;
    },

    handoff(config: MCPHandoffConfig<any, any, any, any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .handoff()`);
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .handoff()`);
      }

      const callable = makeUnifiedCallable<any, any>({
        name: state.name,
        parameters: state.parameters,
        handoffConfig: config,
      });
      const finalized = callable as FinalizedMCPTool<any, any, any, any, any> & UnifiedCallable<any, any>;
      Object.defineProperties(finalized, {
        _types: { value: undefined as any, enumerable: true, writable: true, configurable: true },
        name: { value: state.name, enumerable: true, writable: true, configurable: true },
        description: { value: state.description, enumerable: true, writable: true, configurable: true },
        parameters: { value: state.parameters, enumerable: true, writable: true, configurable: true },
        requires: { value: state.requires, enumerable: true, writable: true, configurable: true },
        handoffConfig: { value: config, enumerable: true, writable: true, configurable: true },
        schemas: { value: { input: state.parameters, output: undefined }, enumerable: true, writable: true, configurable: true },
        capabilities: { value: state.requires ?? { elicitation: true, sampling: true }, enumerable: true, writable: true, configurable: true },
      });
      return finalized;
    },
  };

  return builder;
}

/**
 * Create a type-safe MCP tool using the builder pattern.
 *
 * @param name - Unique tool name (used by LLM to invoke)
 * @returns Builder for configuring the tool
 *
 * @example
 * ```typescript
 * const myTool = createMCPTool('my_tool')
 *   .description('Does something')
 *   .parameters(z.object({ input: z.string() }))
 *   .execute(function*(params, ctx) {
 *     const result = yield* ctx.elicit({
 *       message: 'Confirm?',
 *       schema: z.object({ confirmed: z.boolean() })
 *     })
 *     return result
 *   })
 * ```
 */
export function createMCPTool<TName extends string = string>(
  name?: TName,
): MCPToolBuilderBase<TName> {
  return createBuilder({ name: name ?? ("" as string) }) as MCPToolBuilderBase<TName>;
}
