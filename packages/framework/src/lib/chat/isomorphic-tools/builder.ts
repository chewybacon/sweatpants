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
 * @example Server-authority tool with V7 handoff
 * ```typescript
 * const guessCard = createIsomorphicTool('guess_the_card')
 *   .description('Pick and guess a card')
 *   .parameters(z.object({ prompt: z.string().optional() }))
 *   .authority('server')
 *   .handoff({
 *     *before(params) {
 *       const secret = pickRandomCard()
 *       return { secret, choices: generateChoices(secret) }
 *     },
 *     *client(handoff, ctx, params) {
 *       // handoff is { secret: Card, choices: Card[] }
 *       return { guess: yield* showChoices(handoff.choices) }
 *     },
 *     *after(handoff, client) {
 *       // handoff: { secret: Card, choices: Card[] }
 *       // client: { guess: string }
 *       return { correct: client.guess === handoff.secret }
 *     },
 *   })
 * ```
 *
 * @example Client-authority tool
 * ```typescript
 * const getUserChoice = createIsomorphicTool('get_user_choice')
 *   .description('Get a choice from the user')
 *   .parameters(z.object({ options: z.array(z.string()) }))
 *   .authority('client')
 *   .client(function*(params, ctx) {
 *     const choice = yield* showChoiceDialog(params.options)
 *     return { choice }
 *   })
 *   .server(function*(params, ctx, clientOutput) {
 *     // clientOutput is { choice: string }
 *     return { validated: params.options.includes(clientOutput.choice) }
 *   })
 * ```
 */
import type { Operation } from 'effection'
import type { z } from 'zod'
import type { ClientToolContext } from './runtime/tool-runtime'
import type {
  IsomorphicApprovalConfig,
  ServerToolContext,
  ServerAuthorityContext,
} from './types'

type BuilderAuthorityMode = 'server' | 'client'

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 * Uses `in out` variance for bidirectional type flow (like TanStack Start).
 */
export interface IsomorphicToolTypes<
  in out TParams,
  in out TAuthority extends BuilderAuthorityMode | undefined,
  in out THandoff,
  in out TClient,
  in out TResult,
> {
  params: TParams
  authority: TAuthority
  handoff: THandoff
  client: TClient
  result: TResult
}

// =============================================================================
// HANDOFF BUILDER TYPES (V7 Pattern)
// =============================================================================

/**
 * Configuration for server-authority handoff.
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
export interface TypedHandoffConfig<TParams, THandoff, TClient, TResult> {
  /**
   * Phase 1: Compute state (runs ONCE).
   * Return value is cached and sent to client.
   */
  before: (params: TParams, ctx: ServerToolContext) => Operation<THandoff>

  /**
   * Client execution: Show UI, collect input.
   * Receives handoff data from before().
   */
  client: (
    handoff: THandoff,
    ctx: ClientToolContext,
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
 * Has name + description + params, needs authority.
 */
export interface IsomorphicToolBuilderWithParams<TName extends string, TParams> {
  _types: IsomorphicToolTypes<TParams, undefined, undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>

  /**
   * Set the authority mode.
   */
  authority<TAuth extends 'server' | 'client'>(
    mode: TAuth
  ): TAuth extends 'server'
    ? IsomorphicToolBuilderServerAuthority<TName, TParams>
    : IsomorphicToolBuilderClientAuthority<TName, TParams>
}

// =============================================================================
// AUTHORITY-SPECIFIC BUILDERS
// =============================================================================

/**
 * Server authority builder - can use handoff pattern or simple server/client.
 */
export interface IsomorphicToolBuilderServerAuthority<TName extends string, TParams> {
  _types: IsomorphicToolTypes<TParams, 'server', undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _authority: 'server'

  /**
   * V7 handoff pattern - server picks state, client interacts, server validates.
   *
   * This provides full type safety across phases:
   * - `before()` return type flows to `handoff` param in `client()` and `after()`
   * - `client()` return type flows to `client` param in `after()`
   * - `after()` return type is the final result
   */
  handoff<THandoff, TClient, TResult>(
    config: TypedHandoffConfig<TParams, THandoff, TClient, TResult>
  ): FinalizedIsomorphicTool<TName, TParams, 'server', THandoff, TClient, TResult>

  /**
   * Simple server-only execution (no handoff).
   * Server runs, returns result, optionally client does side effects.
   */
  server<TServerOutput>(
    fn: (params: TParams, ctx: ServerAuthorityContext) => Operation<TServerOutput>
  ): IsomorphicToolBuilderServerOnly<TName, TParams, TServerOutput>

  /**
   * Set approval configuration.
   */
  approval(config: IsomorphicApprovalConfig): this
}

/**
 * After server() is set, can optionally add client().
 */
export interface IsomorphicToolBuilderServerOnly<TName extends string, TParams, TServerOutput> {
  _types: IsomorphicToolTypes<TParams, 'server', undefined, undefined, TServerOutput>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _authority: 'server'

  /**
   * Add client-side presentation (receives server output).
   */
  client<TClientOutput>(
    fn: (
      serverOutput: TServerOutput,
      ctx: ClientToolContext,
      params: TParams
    ) => Operation<TClientOutput>
  ): FinalizedIsomorphicTool<TName, TParams, 'server', undefined, TClientOutput, TServerOutput>

  /**
   * Finalize without client (server-only tool).
   */
  build(): FinalizedIsomorphicTool<TName, TParams, 'server', undefined, undefined, TServerOutput>
}

/**
 * Client authority builder - client runs first, then server.
 */
export interface IsomorphicToolBuilderClientAuthority<TName extends string, TParams> {
  _types: IsomorphicToolTypes<TParams, 'client', undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _authority: 'client'

  /**
   * Client-side execution (runs first).
   */
  client<TClientOutput>(
    fn: (params: TParams, ctx: ClientToolContext) => Operation<TClientOutput>
  ): IsomorphicToolBuilderClientFirst<TName, TParams, TClientOutput>

  /**
   * Set approval configuration.
   */
  approval(config: IsomorphicApprovalConfig): this
}

/**
 * After client() is set, you can either:
 * - add an explicit server() validator/processor, or
 * - build() to use a default server passthrough.
 */
export interface IsomorphicToolBuilderClientFirst<TName extends string, TParams, TClientOutput> {
  _types: IsomorphicToolTypes<TParams, 'client', undefined, TClientOutput, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _authority: 'client'

  /**
   * Server-side validation (receives client output).
   */
  server<TServerOutput>(
    fn: (
      params: TParams,
      ctx: ServerToolContext,
      clientOutput: TClientOutput
    ) => Operation<TServerOutput>
  ): FinalizedIsomorphicTool<TName, TParams, 'client', undefined, TClientOutput, TServerOutput>

  /**
   * Finalize with a default server passthrough.
   *
   * This ensures the server phase always exists, even for client-only tools.
   */
  build(): FinalizedIsomorphicTool<TName, TParams, 'client', undefined, TClientOutput, TClientOutput>
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
  TAuthority extends BuilderAuthorityMode,
  THandoff,
  TClient,
  TResult,
> {
  /**
   * Phantom type carrier - no runtime cost.
   * Access with `tool._types.result` etc. for type-level operations.
   */
  _types: IsomorphicToolTypes<TParams, TAuthority, THandoff, TClient, TResult>

  /** Tool name (used by LLM) */
  name: TName

  /** Description (shown to LLM) */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /** Authority mode */
  authority: TAuthority

  /** Approval configuration */
  approval?: IsomorphicApprovalConfig

  /**
   * For handoff tools: the typed handoff config.
   * Allows executor to access before/client/after with types.
   */
  handoffConfig?: TypedHandoffConfig<TParams, THandoff, TClient, TResult>

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
    input: TResult | TParams | THandoff,
    ctx: ClientToolContext,
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
  authority?: BuilderAuthorityMode
  approval?: IsomorphicApprovalConfig
  handoffConfig?: TypedHandoffConfig<any, any, any, any>
  serverFn?: (params: any, ctx: any, clientOutput?: any) => Operation<any>
  clientFn?: (input: any, ctx: ClientToolContext, params: any) => Operation<any>
}

function createBuilder(state: BuilderState): any {
  const builder = {
    _types: undefined as any, // Phantom - no runtime cost
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,
    _authority: state.authority,

    description(desc: string) {
      return createBuilder({ ...state, description: desc })
    },

    parameters(schema: z.ZodType) {
      return createBuilder({ ...state, parameters: schema })
    },

    authority(mode: BuilderAuthorityMode) {
      return createBuilder({ ...state, authority: mode })
    },

    approval(config: IsomorphicApprovalConfig) {
      return createBuilder({ ...state, approval: config })
    },

    handoff(config: TypedHandoffConfig<any, any, any, any>) {
      // Finalize with handoff config
      return {
        _types: undefined as any,
        name: state.name,
        description: state.description!,
        parameters: state.parameters!,
        authority: 'server' as const,
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

      // For server authority without handoff, return builder that can add client
      if (state.authority === 'server') {
        return {
          ...createBuilder(newState),
          client(clientFn: (input: any, ctx: ClientToolContext, params: any) => Operation<any>) {
            return {
              _types: undefined as any,
              name: state.name,
              description: state.description!,
              parameters: state.parameters!,
              authority: 'server' as const,
              approval: state.approval,
              server: fn,
              client: clientFn,
            } as FinalizedIsomorphicTool<any, any, 'server', any, any, any>
          },
          build() {
            return {
              _types: undefined as any,
              name: state.name,
              description: state.description!,
              parameters: state.parameters!,
              authority: 'server' as const,
              approval: state.approval,
              server: fn,
            } as FinalizedIsomorphicTool<any, any, 'server', any, any, any>
          },
        }
      }

      // For client authority, server comes after client
      if (state.authority === 'client' && state.clientFn) {
        return {
          _types: undefined as any,
          name: state.name,
          description: state.description!,
          parameters: state.parameters!,
          authority: 'client' as const,
          approval: state.approval,
          server: fn,
          client: state.clientFn,
        } as FinalizedIsomorphicTool<any, any, 'client', any, any, any>
      }

      return createBuilder(newState)
    },

    client(fn: (input: any, ctx: ClientToolContext, params?: any) => Operation<any>) {
      const newState = { ...state, clientFn: fn }

      // For client authority, client comes first
      if (state.authority === 'client') {
        return {
          ...createBuilder(newState),
          server(serverFn: (params: any, ctx: any, clientOutput: any) => Operation<any>) {
            return {
              _types: undefined as any,
              name: state.name,
              description: state.description!,
              parameters: state.parameters!,
              authority: 'client' as const,
              approval: state.approval,
              server: serverFn,
              client: fn,
            } as FinalizedIsomorphicTool<any, any, 'client', any, any, any>
          },
          build() {
            // Default server passthrough for client-only tools.
            // Keeps server phase present for middleware/plugins, even if it simply returns client output.
            const passthroughServer = function*(_params: any, _ctx: any, clientOutput: any) {
              return clientOutput
            }

            return {
              _types: undefined as any,
              name: state.name,
              description: state.description!,
              parameters: state.parameters!,
              authority: 'client' as const,
              approval: state.approval,
              server: passthroughServer,
              client: fn,
            } as FinalizedIsomorphicTool<any, any, 'client', any, any, any>
          },
        }
      }

      return createBuilder(newState)
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
 *   .authority('server')
 *   .handoff({
 *     *before(params) { return { computed: params.input.toUpperCase() } },
 *     *client(handoff) { return { userSaw: true } },
 *     *after(handoff, client) { return { result: handoff.computed, acknowledged: client.userSaw } },
 *   })
 * ```
 */
export function createIsomorphicTool<TName extends string>(
  name: TName
): IsomorphicToolBuilderBase<TName> {
  return createBuilder({ name }) as IsomorphicToolBuilderBase<TName>
}
