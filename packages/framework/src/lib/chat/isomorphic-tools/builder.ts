/**
 * Type-Safe Isomorphic Tool Builder
 *
 * Inspired by TanStack Start's createServerFn builder pattern.
 * Each builder method returns a new builder with accumulated types.
 *
 * Key patterns from TanStack Start:
 * - `_types` phantom field for compile-time type info
 * - `in out` variance modifiers for bidirectional type flow
 * - Builder chain with type accumulation
 *
 * ## Usage
 *
 * @example Server-first tool with V7 handoff (agent context)
 * ```typescript
 * const analyzerTool = createIsomorphicTool('analyzer')
 *   .description('Analyze text using AI')
 *   .parameters(z.object({ text: z.string() }))
 *   .context('agent')
 *   .handoff({
 *     *before(params) {
 *       return { text: params.text }
 *     },
 *     *client(handoff, ctx, params) {
 *       // ctx is AgentToolContext - prompt is guaranteed
 *       return yield* ctx.prompt({ prompt: handoff.text, schema: z.object({}) })
 *     },
 *     *after(handoff, client) {
 *       return { analyzed: true, ...client }
 *     },
 *   })
 * ```
 *
 * @example Browser tool with UI interaction
 * ```typescript
 * const pickerTool = createIsomorphicTool('picker')
 *   .description('Let user pick an option')
 *   .parameters(z.object({ options: z.array(z.string()) }))
 *   .context('browser')
 *   .handoff({
 *     *before(params) {
 *       return { options: params.options }
 *     },
 *     *client(handoff, ctx, params) {
 *       // ctx is BrowserToolContext - waitFor is guaranteed
 *       return yield* ctx.waitFor('picker', { options: handoff.options })
 *     },
 *     *after(handoff, client) {
 *       return { picked: client.selected }
 *     },
 *   })
 * ```
 */
import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  ContextMode,
  ContextForMode,
} from './contexts.ts'
import type { IsomorphicApprovalConfig, ServerToolContext, ServerAuthorityContext } from './types.ts'

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 * Uses `in out` variance for bidirectional type flow (like TanStack Start).
 */
export interface IsomorphicToolTypes<
  in out TParams,
  in out TContext extends ContextMode | undefined,
  in out THandoff,
  in out TClient,
  in out TResult,
> {
  params: TParams
  context: TContext
  handoff: THandoff
  client: TClient
  result: TResult
}

// =============================================================================
// HANDOFF BUILDER TYPES (V7 Pattern)
// =============================================================================

/**
 * Configuration for server-first handoff.
 *
 * Type flow:
 * ```
 * TParams ──► before(params) → THandoff
 *                                │
 *        ┌───────────────────────┤
 *        ▼                       ▼
 * client(handoff, ctx, params) → TClient
 *        │                       │
 *        └───────► after(handoff, client) → TResult
 * ```
 */
export interface TypedHandoffConfig<
  TParams,
  TContext extends ContextMode,
  THandoff,
  TClient,
  TResult,
> {
  /**
   * Phase 1: Compute state (runs ONCE).
   * Return value is cached and sent to client.
   */
  before: (params: TParams, ctx: ServerToolContext) => Operation<THandoff>

  /**
   * Client execution: Show UI or run agent logic.
   * Receives handoff data from before().
   * Context type is determined by TContext.
   */
  client: (
    handoff: THandoff,
    ctx: ContextForMode<TContext>,
    params: TParams
  ) => Operation<TClient>

  /**
   * Phase 2: Validate and return (runs ONCE after client).
   * Receives cached handoff + client response.
   */
  after: (
    handoff: THandoff,
    client: TClient,
    ctx: ServerToolContext,
    params: TParams
  ) => Operation<TResult>
}

// =============================================================================
// BUILDER INTERFACES
// =============================================================================

/**
 * Base builder - has name, needs everything else.
 */
export interface IsomorphicToolBuilderBase<TName extends string> {
  _types: IsomorphicToolTypes<undefined, undefined, undefined, undefined, undefined>
  _name: TName

  /**
   * Set the description shown to the LLM.
   */
  description(desc: string): IsomorphicToolBuilderWithDescription<TName>
}

/**
 * Has name + description, needs parameters.
 */
export interface IsomorphicToolBuilderWithDescription<TName extends string> {
  _types: IsomorphicToolTypes<undefined, undefined, undefined, undefined, undefined>
  _name: TName
  _description: string

  /**
   * Set the Zod schema for tool parameters.
   */
  parameters<TSchema extends z.ZodType>(
    schema: TSchema
  ): IsomorphicToolBuilderWithParams<TName, z.infer<TSchema>>
}

/**
 * Has name + description + params, needs context.
 */
export interface IsomorphicToolBuilderWithParams<TName extends string, TParams> {
  _types: IsomorphicToolTypes<TParams, undefined, undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>

  /**
   * Set the execution context mode.
   *
   * - `headless`: Pure computation, no UI or LLM - can run anywhere
   * - `browser`: Requires UI interaction via waitFor
   * - `agent`: Requires LLM access via prompt
   */
  context<TCtx extends ContextMode>(
    mode: TCtx
  ): IsomorphicToolBuilderWithContext<TName, TParams, TCtx>
}

/**
 * Has name + description + params + context.
 */
export interface IsomorphicToolBuilderWithContext<
  TName extends string,
  TParams,
  TContext extends ContextMode,
> {
  _types: IsomorphicToolTypes<TParams, TContext, undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _context: TContext

  /**
   * V7 handoff pattern - server picks state, client interacts, server validates.
   *
   * This provides full type safety across phases:
   * - `before()` return type flows to `handoff` param in `client()` and `after()`
   * - `client()` return type flows to `client` param in `after()`
   * - `after()` return type is the final result
   * - `ctx` in `client()` is properly typed based on context mode
   */
  handoff<THandoff, TClient, TResult>(
    config: TypedHandoffConfig<TParams, TContext, THandoff, TClient, TResult>
  ): FinalizedIsomorphicTool<TName, TParams, TContext, THandoff, TClient, TResult>

  /**
   * Simple server-only execution (no handoff).
   * Server runs, returns result, optionally client does side effects.
   */
  server<TServerOutput>(
    fn: (params: TParams, ctx: ServerAuthorityContext) => Operation<TServerOutput>
  ): IsomorphicToolBuilderServerOnly<TName, TParams, TContext, TServerOutput>

  /**
   * Client-only execution.
   * Client runs and its output is sent directly to the LLM.
   */
  client<TClientOutput>(
    fn: (
      input: undefined,
      ctx: ContextForMode<TContext>,
      params: TParams
    ) => Operation<TClientOutput>
  ): FinalizedIsomorphicTool<TName, TParams, TContext, undefined, TClientOutput, TClientOutput>

  /**
   * Set approval configuration.
   */
  approval(config: IsomorphicApprovalConfig): this
}

/**
 * After server() is set, can optionally add client().
 */
export interface IsomorphicToolBuilderServerOnly<
  TName extends string,
  TParams,
  TContext extends ContextMode,
  TServerOutput,
> {
  _types: IsomorphicToolTypes<TParams, TContext, undefined, undefined, TServerOutput>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _context: TContext

  /**
   * Add client-side presentation (receives server output).
   */
  client<TClientOutput>(
    fn: (
      serverOutput: TServerOutput,
      ctx: ContextForMode<TContext>,
      params: TParams
    ) => Operation<TClientOutput>
  ): FinalizedIsomorphicTool<TName, TParams, TContext, undefined, TClientOutput, TServerOutput>

  /**
   * Finalize without client (server-only tool).
   */
  build(): FinalizedIsomorphicTool<TName, TParams, TContext, undefined, undefined, TServerOutput>
}

// =============================================================================
// FINALIZED TOOL
// =============================================================================

/**
 * A fully configured isomorphic tool.
 *
 * The `_types` field carries compile-time type information for:
 * - Type-level tests (expectTypeOf)
 * - Integration with the registry
 * - Safe extraction of types
 */
export interface FinalizedIsomorphicTool<
  TName extends string,
  TParams,
  TContext extends ContextMode,
  THandoff,
  TClient,
  TResult,
> {
  /**
   * Phantom type carrier - no runtime cost.
   * Access with `tool._types.result` etc. for type-level operations.
   */
  _types: IsomorphicToolTypes<TParams, TContext, THandoff, TClient, TResult>

  /** Tool name (used by LLM) */
  name: TName

  /** Description (shown to LLM) */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /** Execution context mode */
  contextMode: TContext

  /** Approval configuration */
  approval?: IsomorphicApprovalConfig

  /**
   * For handoff tools: the typed handoff config.
   * Allows executor to access before/client/after with types.
   */
  handoffConfig?: TypedHandoffConfig<TParams, TContext, THandoff, TClient, TResult>

  /**
   * Server-side execution (for non-handoff tools).
   */
  server?: (
    params: TParams,
    ctx: ServerToolContext | ServerAuthorityContext,
    clientOutput?: TClient
  ) => Operation<TResult>

  /**
   * Client-side execution (for non-handoff tools).
   */
  client?: (
    input: TResult | THandoff,
    ctx: ContextForMode<TContext>,
    params: TParams
  ) => Operation<TClient>
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the result type from a finalized tool.
 */
export type InferToolResult<T> = T extends FinalizedIsomorphicTool<
  any,
  any,
  any,
  any,
  any,
  infer TResult
>
  ? TResult
  : never

/**
 * Extract the params type from a finalized tool.
 */
export type InferToolParams<T> = T extends FinalizedIsomorphicTool<
  any,
  infer TParams,
  any,
  any,
  any,
  any
>
  ? TParams
  : never

/**
 * Extract the context mode from a finalized tool.
 */
export type InferToolContext<T> = T extends FinalizedIsomorphicTool<
  any,
  any,
  infer TContext,
  any,
  any,
  any
>
  ? TContext
  : never

/**
 * Extract the handoff type from a finalized tool.
 */
export type InferToolHandoff<T> = T extends FinalizedIsomorphicTool<
  any,
  any,
  any,
  infer THandoff,
  any,
  any
>
  ? THandoff
  : never

/**
 * Extract the client output type from a finalized tool.
 */
export type InferToolClientOutput<T> = T extends FinalizedIsomorphicTool<
  any,
  any,
  any,
  any,
  infer TClient,
  any
>
  ? TClient
  : never

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface BuilderState {
  name: string
  description?: string
  parameters?: z.ZodType
  contextMode?: ContextMode
  approval?: IsomorphicApprovalConfig
  handoffConfig?: TypedHandoffConfig<any, any, any, any, any>
  serverFn?: (params: any, ctx: any, clientOutput?: any) => Operation<any>
  clientFn?: (input: any, ctx: any, params: any) => Operation<any>
}

function createBuilder(state: BuilderState): any {
  const builder = {
    _types: undefined as any, // Phantom - no runtime cost
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,
    _context: state.contextMode,

    description(desc: string) {
      return createBuilder({ ...state, description: desc })
    },

    parameters(schema: z.ZodType) {
      return createBuilder({ ...state, parameters: schema })
    },

    context(mode: ContextMode) {
      return createBuilder({ ...state, contextMode: mode })
    },

    approval(config: IsomorphicApprovalConfig) {
      return createBuilder({ ...state, approval: config })
    },

    handoff(config: TypedHandoffConfig<any, any, any, any, any>) {
      // Validate required fields
      if (!state.contextMode) {
        throw new Error(`Tool "${state.name}": .context() must be called before .handoff()`)
      }

      // Finalize with handoff config
      return {
        _types: undefined as any,
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        contextMode: state.contextMode,
        approval: state.approval,
        handoffConfig: config,
        // For compatibility, also set server/client that use the handoff
        server: function*(params: any, ctx: ServerAuthorityContext) {
          // This wrapper is for the executor - it uses handoff() internally
          return yield* ctx.handoff({
            *before() { return yield* config.before(params, ctx) },
            *after(handoff: any, client: any) {
              return yield* config.after(handoff, client, ctx, params)
            },
          })
        },
        client: config.client,
      } as FinalizedIsomorphicTool<any, any, any, any, any, any>
    },

    server(fn: (params: any, ctx: any, clientOutput?: any) => Operation<any>) {
      const newState = { ...state, serverFn: fn }

      return {
        ...createBuilder(newState),
        client(clientFn: (input: any, ctx: any, params: any) => Operation<any>) {
          if (!state.contextMode) {
            throw new Error(`Tool "${state.name}": .context() must be called before .client()`)
          }
          return {
            _types: undefined as any,
            name: state.name,
            description: state.description!,
            parameters: state.parameters!,
            contextMode: state.contextMode,
            approval: state.approval,
            server: fn,
            client: clientFn,
          } as FinalizedIsomorphicTool<any, any, any, any, any, any>
        },
        build() {
          if (!state.contextMode) {
            throw new Error(`Tool "${state.name}": .context() must be called before .build()`)
          }
          return {
            _types: undefined as any,
            name: state.name,
            description: state.description!,
            parameters: state.parameters!,
            contextMode: state.contextMode,
            approval: state.approval,
            server: fn,
          } as FinalizedIsomorphicTool<any, any, any, any, any, any>
        },
      }
    },

    client(fn: (input: any, ctx: any, params?: any) => Operation<any>) {
      if (!state.contextMode) {
        throw new Error(`Tool "${state.name}": .context() must be called before .client()`)
      }
      return {
        _types: undefined as any,
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        contextMode: state.contextMode,
        approval: state.approval,
        client: fn,
      } as FinalizedIsomorphicTool<any, any, any, any, any, any>
    },
  }

  return builder
}

/**
 * Create a type-safe isomorphic tool using the builder pattern.
 *
 * @param name - Unique tool name (used by LLM to invoke)
 * @returns Builder for configuring the tool
 *
 * @example
 * ```typescript
 * const myTool = createIsomorphicTool('my_tool')
 *   .description('Does something')
 *   .parameters(z.object({ input: z.string() }))
 *   .context('agent')  // or 'browser' or 'headless'
 *   .handoff({
 *     *before(params) { return { computed: params.input.toUpperCase() } },
 *     *client(handoff, ctx) {
 *       // ctx is AgentToolContext - prompt is guaranteed
 *       return yield* ctx.prompt({ ... })
 *     },
 *     *after(handoff, client) { return { result: handoff.computed } },
 *   })
 * ```
 */
export function createIsomorphicTool<TName extends string>(
  name: TName
): IsomorphicToolBuilderBase<TName> {
  return createBuilder({ name }) as IsomorphicToolBuilderBase<TName>
}
