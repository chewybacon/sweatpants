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
import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  MCPClientContext,
  MCPHandoffConfig,
} from './types'

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 * Uses `in out` variance for bidirectional type flow.
 */
export interface MCPToolTypes<
  in out TParams,
  in out THandoff,
  in out TClient,
  in out TResult,
> {
  params: TParams
  handoff: THandoff
  client: TClient
  result: TResult
}

// =============================================================================
// BUILDER INTERFACES
// =============================================================================

/**
 * Base builder - has name, needs everything else.
 */
export interface MCPToolBuilderBase<TName extends string> {
  _types: MCPToolTypes<undefined, undefined, undefined, undefined>
  _name: TName

  /** Set the description shown to the LLM */
  description(desc: string): MCPToolBuilderWithDescription<TName>
}

/**
 * Has name + description, needs parameters.
 */
export interface MCPToolBuilderWithDescription<TName extends string> {
  _types: MCPToolTypes<undefined, undefined, undefined, undefined>
  _name: TName
  _description: string

  /** Set the Zod schema for tool parameters */
  parameters<TSchema extends z.ZodType>(
    schema: TSchema
  ): MCPToolBuilderWithParams<TName, z.infer<TSchema>>
}

/**
 * Has name + description + params, can set requires or define execution.
 */
export interface MCPToolBuilderWithParams<TName extends string, TParams> {
  _types: MCPToolTypes<TParams, undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>

  /**
   * Declare required MCP client capabilities.
   * Tool won't be listed if client doesn't have these.
   */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): this

  /**
   * Define a simple execute function (no handoff).
   * For tools that don't need the before/client/after pattern.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: MCPClientContext) => Operation<TResult>
  ): FinalizedMCPTool<TName, TParams, undefined, undefined, TResult>

  /**
   * Define handoff pattern for multi-turn interaction.
   */
  handoff<THandoff, TClient, TResult>(
    config: MCPHandoffConfig<TParams, THandoff, TClient, TResult>
  ): FinalizedMCPTool<TName, TParams, THandoff, TClient, TResult>
}

// =============================================================================
// FINALIZED TOOL
// =============================================================================

/**
 * A fully configured MCP tool.
 */
export interface FinalizedMCPTool<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
> {
  /** Phantom type carrier */
  _types: MCPToolTypes<TParams, THandoff, TClient, TResult>

  /** Tool name (used by LLM) */
  name: TName

  /** Description (shown to LLM) */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /** Required MCP capabilities */
  requires?: { elicitation?: boolean; sampling?: boolean }

  /** Handoff config (if using handoff pattern) */
  handoffConfig?: MCPHandoffConfig<TParams, THandoff, TClient, TResult>

  /** Execute function (if not using handoff) */
  execute?: (params: TParams, ctx: MCPClientContext) => Operation<TResult>
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the result type from a finalized tool.
 */
export type InferMCPResult<T> = T extends FinalizedMCPTool<any, any, any, any, infer R>
  ? R
  : never

/**
 * Extract the params type from a finalized tool.
 */
export type InferMCPParams<T> = T extends FinalizedMCPTool<any, infer P, any, any, any>
  ? P
  : never

/**
 * Extract the handoff type from a finalized tool.
 */
export type InferMCPHandoff<T> = T extends FinalizedMCPTool<any, any, infer H, any, any>
  ? H
  : never

/**
 * Extract the client output type from a finalized tool.
 */
export type InferMCPClient<T> = T extends FinalizedMCPTool<any, any, any, infer C, any>
  ? C
  : never

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface BuilderState {
  name: string
  description?: string
  parameters?: z.ZodType
  requires?: { elicitation?: boolean; sampling?: boolean }
  handoffConfig?: MCPHandoffConfig<any, any, any, any>
  executeFn?: (params: any, ctx: MCPClientContext) => Operation<any>
}

function createBuilder(state: BuilderState): any {
  const builder = {
    _types: undefined as any,
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,

    description(desc: string) {
      return createBuilder({ ...state, description: desc })
    },

    parameters(schema: z.ZodType) {
      return createBuilder({ ...state, parameters: schema })
    },

    requires(caps: { elicitation?: boolean; sampling?: boolean }) {
      return createBuilder({ ...state, requires: caps })
    },

    execute(fn: (params: any, ctx: MCPClientContext) => Operation<any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .execute()`)
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .execute()`)
      }

      return {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        requires: state.requires,
        execute: fn,
      } as FinalizedMCPTool<any, any, undefined, undefined, any>
    },

    handoff(config: MCPHandoffConfig<any, any, any, any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .handoff()`)
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .handoff()`)
      }

      return {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        requires: state.requires,
        handoffConfig: config,
      } as FinalizedMCPTool<any, any, any, any, any>
    },
  }

  return builder
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
export function createMCPTool<TName extends string>(
  name: TName
): MCPToolBuilderBase<TName> {
  return createBuilder({ name }) as MCPToolBuilderBase<TName>
}
