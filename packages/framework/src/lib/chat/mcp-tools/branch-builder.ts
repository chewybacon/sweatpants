/**
 * Branch-Based MCP Tool Builder
 *
 * Type-safe builder for creating MCP tools with branch-based execution.
 *
 * ## Usage
 *
 * @example Simple tool (no handoff)
 * ```typescript
 * const calculator = createBranchTool('calculate')
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
 * const bookFlight = createBranchTool('book_flight')
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
import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  BranchContext,
  BranchContextWithElicits,
  BranchHandoffConfig,
  BranchHandoffConfigWithElicits,
  BranchLimits,
  ElicitsMap,
} from './branch-types'

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 */
export interface BranchToolTypes<
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
export interface BranchToolBuilderBase<TName extends string> {
  _types: BranchToolTypes<undefined, undefined, undefined, undefined>
  _name: TName

  /** Set the description shown to the LLM */
  description(desc: string): BranchToolBuilderWithDescription<TName>
}

/**
 * Has name + description, needs parameters.
 */
export interface BranchToolBuilderWithDescription<TName extends string> {
  _types: BranchToolTypes<undefined, undefined, undefined, undefined>
  _name: TName
  _description: string

  /** Set the Zod schema for tool parameters */
  parameters<TSchema extends z.ZodType>(
    schema: TSchema
  ): BranchToolBuilderWithParams<TName, z.infer<TSchema>>
}

/**
 * Has name + description + params, can set requires/limits or define execution.
 */
export interface BranchToolBuilderWithParams<TName extends string, TParams> {
  _types: BranchToolTypes<TParams, undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>

  /**
   * Declare required MCP client capabilities.
   * Tool won't be listed if client doesn't have these.
   */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): this

  /**
   * Set default limits for branch execution.
   * Can be overridden at runtime or per-branch.
   */
  limits(limits: BranchLimits): this

  /**
   * Declare a finite elicitation surface for type-safe UI bridging.
   *
   * When you call `.elicits({...})`, the tool becomes "bridgeable":
   * - `ctx.elicit` becomes keyed: `ctx.elicit('pickFlight', { message: '...' })`
   * - The derived plugin must implement handlers for every key (exhaustive)
   * - Type safety is guaranteed across server/client boundary
   *
   * @example
   * ```typescript
   * const tool = createBranchTool('book_flight')
   *   .description('Book a flight')
   *   .parameters(z.object({ destination: z.string() }))
   *   .elicits({
   *     pickFlight: z.object({ flightId: z.string() }),
   *     confirm: z.object({ ok: z.boolean() }),
   *   })
   *   .handoff({
   *     *client(handoff, ctx) {
   *       const picked = yield* ctx.elicit('pickFlight', { message: 'Pick' })
   *       const ok = yield* ctx.elicit('confirm', { message: 'Confirm?' })
   *       return { picked, ok }
   *     }
   *   })
   * ```
   */
  elicits<TElicits extends ElicitsMap>(
    schemas: TElicits
  ): BranchToolBuilderWithElicits<TName, TParams, TElicits>

  /**
   * Define a simple execute function (no handoff).
   * For tools that don't need the before/client/after pattern.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: BranchContext) => Operation<TResult>
  ): FinalizedBranchTool<TName, TParams, undefined, undefined, TResult>

  /**
   * Define handoff pattern for multi-turn interaction.
   */
  handoff<THandoff, TClient, TResult>(
    config: BranchHandoffConfig<TParams, THandoff, TClient, TResult>
  ): FinalizedBranchTool<TName, TParams, THandoff, TClient, TResult>
}

/**
 * Has name + description + params + elicits, can set requires/limits or define execution.
 */
export interface BranchToolBuilderWithElicits<
  TName extends string,
  TParams,
  TElicits extends ElicitsMap,
> {
  _types: BranchToolTypes<TParams, undefined, undefined, undefined>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _elicits: TElicits

  /**
   * Declare required MCP client capabilities.
   */
  requires(caps: { elicitation?: boolean; sampling?: boolean }): this

  /**
   * Set default limits for branch execution.
   */
  limits(limits: BranchLimits): this

  /**
   * Define a simple execute function with keyed elicitation.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: BranchContextWithElicits<TElicits>) => Operation<TResult>
  ): FinalizedBranchToolWithElicits<TName, TParams, undefined, undefined, TResult, TElicits>

  /**
   * Define handoff pattern with keyed elicitation.
   */
  handoff<THandoff, TClient, TResult>(
    config: BranchHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>
  ): FinalizedBranchToolWithElicits<TName, TParams, THandoff, TClient, TResult, TElicits>
}

// =============================================================================
// FINALIZED TOOL
// =============================================================================

/**
 * A fully configured branch-based MCP tool.
 */
export interface FinalizedBranchTool<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
> {
  /** Phantom type carrier */
  _types: BranchToolTypes<TParams, THandoff, TClient, TResult>

  /** Tool name (used by LLM) */
  name: TName

  /** Description (shown to LLM) */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /** Required MCP capabilities */
  requires?: { elicitation?: boolean; sampling?: boolean }

  /** Default limits for branch execution */
  limits?: BranchLimits

  /** Handoff config (if using handoff pattern) */
  handoffConfig?: BranchHandoffConfig<TParams, THandoff, TClient, TResult>

  /** Execute function (if not using handoff) */
  execute?: (params: TParams, ctx: BranchContext) => Operation<TResult>
}

/**
 * A fully configured branch-based MCP tool with keyed elicitation.
 *
 * This tool is "bridgeable" - it can be derived into a plugin with
 * exhaustive, type-safe UI handlers for each elicitation key.
 */
export interface FinalizedBranchToolWithElicits<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
> {
  /** Phantom type carrier */
  _types: BranchToolTypes<TParams, THandoff, TClient, TResult>

  /** Tool name (used by LLM) */
  name: TName

  /** Description (shown to LLM) */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /** Elicitation schemas map (finite surface for UI bridging) */
  elicits: TElicits

  /** Required MCP capabilities */
  requires?: { elicitation?: boolean; sampling?: boolean }

  /** Default limits for branch execution */
  limits?: BranchLimits

  /** Handoff config with keyed elicitation */
  handoffConfig?: BranchHandoffConfigWithElicits<TParams, THandoff, TClient, TResult, TElicits>

  /** Execute function with keyed elicitation */
  execute?: (params: TParams, ctx: BranchContextWithElicits<TElicits>) => Operation<TResult>
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the result type from a finalized tool.
 */
export type InferBranchResult<T> = T extends FinalizedBranchTool<any, any, any, any, infer R>
  ? R
  : never

/**
 * Extract the params type from a finalized tool.
 */
export type InferBranchParams<T> = T extends FinalizedBranchTool<any, infer P, any, any, any>
  ? P
  : never

/**
 * Extract the handoff type from a finalized tool.
 */
export type InferBranchHandoff<T> = T extends FinalizedBranchTool<any, any, infer H, any, any>
  ? H
  : never

/**
 * Extract the client output type from a finalized tool.
 */
export type InferBranchClient<T> = T extends FinalizedBranchTool<any, any, any, infer C, any>
  ? C
  : never

/**
 * Any branch tool (for arrays/registries).
 */
export type AnyBranchTool = FinalizedBranchTool<string, any, any, any, any>

/**
 * Any bridgeable branch tool (has `.elicits()`).
 */
export type AnyBridgeableBranchTool = FinalizedBranchToolWithElicits<string, any, any, any, any, ElicitsMap>

/**
 * Extract the elicits map from a bridgeable tool.
 */
export type InferBranchElicits<T> = T extends FinalizedBranchToolWithElicits<any, any, any, any, any, infer E>
  ? E
  : never

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface BuilderState {
  name: string
  description?: string
  parameters?: z.ZodType
  elicits?: ElicitsMap
  requires?: { elicitation?: boolean; sampling?: boolean }
  limits?: BranchLimits
  handoffConfig?: BranchHandoffConfig<any, any, any, any>
  executeFn?: (params: any, ctx: BranchContext) => Operation<any>
}

function createBuilder(state: BuilderState): any {
  const builder = {
    _types: undefined as any,
    _name: state.name,
    _description: state.description,
    _parameters: state.parameters,
    _elicits: state.elicits,

    description(desc: string) {
      return createBuilder({ ...state, description: desc })
    },

    parameters(schema: z.ZodType) {
      return createBuilder({ ...state, parameters: schema })
    },

    elicits(schemas: ElicitsMap) {
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .elicits()`)
      }
      return createBuilder({ ...state, elicits: schemas })
    },

    requires(caps: { elicitation?: boolean; sampling?: boolean }) {
      return createBuilder({ ...state, requires: caps })
    },

    limits(limits: BranchLimits) {
      return createBuilder({ ...state, limits })
    },

    execute(fn: (params: any, ctx: any) => Operation<any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .execute()`)
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .execute()`)
      }

      // If elicits is defined, return FinalizedBranchToolWithElicits
      if (state.elicits) {
        return {
          _types: undefined as any,
          name: state.name,
          description: state.description,
          parameters: state.parameters,
          elicits: state.elicits,
          requires: state.requires,
          limits: state.limits,
          execute: fn,
        } as FinalizedBranchToolWithElicits<any, any, undefined, undefined, any, any>
      }

      return {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        requires: state.requires,
        limits: state.limits,
        execute: fn,
      } as FinalizedBranchTool<any, any, undefined, undefined, any>
    },

    handoff(config: BranchHandoffConfig<any, any, any, any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .handoff()`)
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .handoff()`)
      }

      // If elicits is defined, return FinalizedBranchToolWithElicits
      if (state.elicits) {
        return {
          _types: undefined as any,
          name: state.name,
          description: state.description,
          parameters: state.parameters,
          elicits: state.elicits,
          requires: state.requires,
          limits: state.limits,
          handoffConfig: config,
        } as FinalizedBranchToolWithElicits<any, any, any, any, any, any>
      }

      return {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        requires: state.requires,
        limits: state.limits,
        handoffConfig: config,
      } as FinalizedBranchTool<any, any, any, any, any>
    },
  }

  return builder
}

/**
 * Create a type-safe branch-based MCP tool using the builder pattern.
 *
 * @param name - Unique tool name (used by LLM to invoke)
 * @returns Builder for configuring the tool
 *
 * @example
 * ```typescript
 * const myTool = createBranchTool('my_tool')
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
 */
export function createBranchTool<TName extends string>(
  name: TName
): BranchToolBuilderBase<TName> {
  return createBuilder({ name }) as BranchToolBuilderBase<TName>
}
