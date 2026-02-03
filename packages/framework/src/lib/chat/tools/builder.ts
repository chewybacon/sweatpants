/**
 * Unified Tool Builder
 *
 * Type-safe builder for creating tools with:
 * - LLM sampling (single-turn and multi-turn)
 * - User elicitation (keyed, type-safe)
 * - Server↔client handoff pattern
 *
 * ## Usage
 *
 * @example Simple tool (server-only, no sampling)
 * ```typescript
 * const calculator = createTool('calculator')
 *   .description('Calculate expression')
 *   .parameters(z.object({ expr: z.string() }))
 *   .execute(function*(params) {
 *     return { result: eval(params.expr) }
 *   })
 * ```
 *
 * @example Tool with LLM sampling
 * ```typescript
 * const greet = createTool('greet')
 *   .description('Generate greeting')
 *   .parameters(z.object({ name: z.string() }))
 *   .execute(function*(params, ctx) {
 *     const result = yield* ctx.sample({ prompt: `Hello ${params.name}` })
 *     return { greeting: result.text }
 *   })
 * ```
 *
 * @example Tool with elicitation
 * ```typescript
 * const pickCard = createTool('pick_card')
 *   .description('Pick a card')
 *   .parameters(z.object({ prompt: z.string() }))
 *   .elicit('pick', z.object({ card: z.string() }))
 *   .handoff({
 *     *before(params) { return { cards: shuffle() } },
 *     *client(handoff, ctx) {
 *       const result = yield* ctx.elicit('pick', { message: 'Pick', cards: handoff.cards })
 *       return { picked: result.content.card }
 *     },
 *     *after(handoff, client) { return { selected: client.picked } }
 *   })
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  ElicitsMap,
  ToolTypes,
  ToolLimits,
  ToolContext,
  ToolContextWithSampling,
  HandoffConfig,
  FinalizedTool,
} from './types.ts'

// =============================================================================
// BUILDER INTERFACES
// =============================================================================

/**
 * Base builder - has name, needs everything else.
 */
export interface ToolBuilderBase<TName extends string> {
  _types: ToolTypes<undefined, undefined, undefined, undefined, Record<string, never>>
  _name: TName

  /** Set the description shown to the LLM */
  description(desc: string): ToolBuilderWithDescription<TName>
}

/**
 * Has name + description, needs parameters.
 */
export interface ToolBuilderWithDescription<TName extends string> {
  _types: ToolTypes<undefined, undefined, undefined, undefined, Record<string, never>>
  _name: TName
  _description: string

  /** Set the Zod schema for tool parameters */
  parameters<TSchema extends z.ZodType>(
    schema: TSchema
  ): ToolBuilderWithParams<TName, z.infer<TSchema>>
}

/**
 * Has name + description + params, can define elicits or execution.
 */
export interface ToolBuilderWithParams<TName extends string, TParams> {
  _types: ToolTypes<TParams, undefined, undefined, undefined, Record<string, never>>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>

  /** Set execution limits */
  limits(limits: ToolLimits): this

  /**
   * Define an elicitation key and schema.
   * Can be chained to define multiple elicits.
   */
  elicit<K extends string, TSchema extends z.ZodType>(
    key: K,
    schema: TSchema
  ): ToolBuilderWithElicits<TName, TParams, Record<K, TSchema>>

  /**
   * Define simple execute function (no elicitation).
   * Use when tool only needs sampling, not user input.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: ToolContextWithSampling) => Operation<TResult>
  ): FinalizedTool<TName, TParams, undefined, undefined, TResult, Record<string, never>>

  /**
   * Define handoff pattern (no elicitation).
   * Use when tool needs server→client→server flow without user input.
   */
  handoff<THandoff, TClient, TResult>(
    config: HandoffConfig<TParams, THandoff, TClient, TResult, Record<string, never>>
  ): FinalizedTool<TName, TParams, THandoff, TClient, TResult, Record<string, never>>
}

/**
 * Has name + description + params + elicits, can add more elicits or define execution.
 */
export interface ToolBuilderWithElicits<
  TName extends string,
  TParams,
  TElicits extends ElicitsMap,
> {
  _types: ToolTypes<TParams, undefined, undefined, undefined, TElicits>
  _name: TName
  _description: string
  _parameters: z.ZodType<TParams>
  _elicits: TElicits

  /** Set execution limits */
  limits(limits: ToolLimits): this

  /**
   * Define another elicitation key and schema.
   * Can be chained to define multiple elicits.
   */
  elicit<K extends string, TSchema extends z.ZodType>(
    key: K,
    schema: TSchema
  ): ToolBuilderWithElicits<TName, TParams, TElicits & Record<K, TSchema>>

  /**
   * Define execute function with elicitation.
   */
  execute<TResult>(
    fn: (params: TParams, ctx: ToolContext<TElicits>) => Operation<TResult>
  ): FinalizedTool<TName, TParams, undefined, undefined, TResult, TElicits>

  /**
   * Define handoff pattern with elicitation.
   */
  handoff<THandoff, TClient, TResult>(
    config: HandoffConfig<TParams, THandoff, TClient, TResult, TElicits>
  ): FinalizedTool<TName, TParams, THandoff, TClient, TResult, TElicits>
}

// =============================================================================
// BUILDER IMPLEMENTATION
// =============================================================================

interface BuilderState {
  name: string
  description?: string
  parameters?: z.ZodType
  elicits: ElicitsMap
  limits?: ToolLimits
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

    elicit(key: string, schema: z.ZodType) {
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .elicit()`)
      }
      return createBuilder({
        ...state,
        elicits: { ...state.elicits, [key]: schema },
      })
    },

    limits(limits: ToolLimits) {
      return createBuilder({ ...state, limits })
    },

    execute(fn: (params: any, ctx: any) => Operation<any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .execute()`)
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .execute()`)
      }

      const tool: FinalizedTool<any, any, undefined, undefined, any, any> = {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        elicits: state.elicits,
        mode: 'execute' as const,
        execute: fn,
        ...(state.limits && { limits: state.limits }),
      }
      return tool
    },

    handoff(config: HandoffConfig<any, any, any, any, any>) {
      if (!state.description) {
        throw new Error(`Tool "${state.name}": .description() must be called before .handoff()`)
      }
      if (!state.parameters) {
        throw new Error(`Tool "${state.name}": .parameters() must be called before .handoff()`)
      }

      const tool: FinalizedTool<any, any, any, any, any, any> = {
        _types: undefined as any,
        name: state.name,
        description: state.description,
        parameters: state.parameters,
        elicits: state.elicits,
        mode: 'handoff' as const,
        handoffConfig: config,
        ...(state.limits && { limits: state.limits }),
      }
      return tool
    },
  }

  return builder
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Create a type-safe tool using the builder pattern.
 *
 * @param name - Unique tool name (used by LLM to invoke)
 * @returns Builder for configuring the tool
 *
 * @example Simple calculator
 * ```typescript
 * const calc = createTool('calculator')
 *   .description('Calculate math expression')
 *   .parameters(z.object({ expr: z.string() }))
 *   .execute(function*(params) {
 *     return { result: eval(params.expr) }
 *   })
 * ```
 *
 * @example Tool with sampling
 * ```typescript
 * const greet = createTool('greet')
 *   .description('Generate greeting')
 *   .parameters(z.object({ name: z.string() }))
 *   .execute(function*(params, ctx) {
 *     const result = yield* ctx.sample({ prompt: `Hello ${params.name}` })
 *     return { greeting: result.text }
 *   })
 * ```
 *
 * @example Tool with elicitation
 * ```typescript
 * const pickCard = createTool('pick_card')
 *   .description('Pick a card')
 *   .parameters(z.object({}))
 *   .elicit('pick', z.object({ card: z.string() }))
 *   .handoff({
 *     *before() { return { cards: ['A', 'K', 'Q'] } },
 *     *client(handoff, ctx) {
 *       const result = yield* ctx.elicit('pick', {
 *         message: 'Pick a card',
 *         cards: handoff.cards
 *       })
 *       if (result.action !== 'accept') return { cancelled: true }
 *       return { picked: result.content.card }
 *     },
 *     *after(handoff, client) {
 *       if ('cancelled' in client) return { error: 'Cancelled' }
 *       return { selected: client.picked }
 *     }
 *   })
 * ```
 */
export function createTool<TName extends string>(name: TName): ToolBuilderBase<TName> {
  return createBuilder({ name, elicits: {} }) as ToolBuilderBase<TName>
}
