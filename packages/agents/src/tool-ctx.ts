/**
 * ToolCtx — the unified leaf context for tool execution.
 *
 * Tools receive a strict subset of AgentCtx plus a tool-local `history`
 * accumulator. They cannot call other tools/agents or access agent state. The
 * typed `elicit` surface is keyed by the tool's declared `.elicits({...})` map.
 */

import type { Operation } from 'effection'

import type {
  DynamicElicitOptions,
  ElicitMode,
  ElicitResult,
  InterruptReason,
  LogLevel,
  Message,
  PerCallInterruptOptions,
  SampleOptions,
  SampleResult,
  ToolCallExchange,
} from './events.ts'

// ============================================================================
// Declared elicit metadata and type extraction (REQ-006/007)
// ============================================================================

export interface ElicitDefinition<TResponseSchema = unknown, TContextSchema = unknown> {
  response?: TResponseSchema
  context?: TContextSchema
  reason?: InterruptReason
  ttlMs?: number
  metadata?: Record<string, unknown>
  mode?: ElicitMode
}

export type ElicitEntry<TResponseSchema = unknown, TContextSchema = unknown> =
  | TResponseSchema
  | ElicitDefinition<TResponseSchema, TContextSchema>

export type ElicitsMap = Record<string, ElicitEntry<any, any>>

/** Zod-like schemas carry the inferred output type on `_output`. */
type InferZodOutput<T> = T extends { _output: infer O } ? O : unknown

export type ExtractElicitResponse<E> = E extends ElicitDefinition<infer TSchema, any>
  ? InferZodOutput<TSchema>
  : InferZodOutput<E>

export type ExtractElicitContext<E> = E extends ElicitDefinition<any, infer TSchema>
  ? TSchema extends undefined
    ? {}
    : InferZodOutput<TSchema>
  : {}

export type ExtractElicitResponseSchema<E> = E extends ElicitDefinition<infer TSchema, any>
  ? TSchema
  : E

export type ExtractElicitContextSchema<E> = E extends ElicitDefinition<any, infer TSchema>
  ? TSchema
  : undefined

export type NormalizedElicitDefinition = Required<Pick<ElicitDefinition, 'mode'>> &
  Omit<ElicitDefinition, 'mode'>

export type NormalizedElicitsMap = Record<string, NormalizedElicitDefinition>

export interface ToolCtx<TElicits extends ElicitsMap = {}> {
  /** Tool-local history accumulator (REQ-010). */
  history: Message[]

  /** Declared keyed elicitation (REQ-007). */
  elicit<K extends keyof TElicits & string>(
    key: K,
    options: { message: string } & ExtractElicitContext<TElicits[K]> & {
        interrupt?: PerCallInterruptOptions
      },
  ): Operation<ElicitResult<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>>

  /** Dynamic per-request elicit escape hatch (REQ-008). */
  elicitDynamic(options: DynamicElicitOptions): Operation<ElicitResult<unknown, unknown>>

  /** LLM sampling (server-resolved or host-fulfilled; REQ-027). */
  sample<TParsed = undefined>(options: SampleOptions<TParsed>): Operation<SampleResult<TParsed>>

  /** Progress notification (REQ-023). */
  notify(message: string, fraction?: number, level?: LogLevel): Operation<void>

  /** Structured log notification (REQ-023). */
  log(level: LogLevel, message: string): Operation<void>
}

/** Canonical unified tool impl signature. */
export type ToolImpl<I, O, TElicits extends ElicitsMap = {}> = (
  input: I,
  ctx: ToolCtx<TElicits>,
) => Operation<O>

/** A unified tool factory the agent `ctx.call` can invoke. */
export interface UnifiedToolFactory<
  I = unknown,
  O = unknown,
  TElicits extends ElicitsMap = ElicitsMap,
> {
  readonly name: string
  readonly description: string
  readonly parameters?: unknown
  readonly elicits?: NormalizedElicitsMap | TElicits | Record<string, unknown>
  readonly schemas?: { input: unknown; output?: unknown }
  readonly capabilities?: { elicitation?: boolean; sampling?: boolean }
  readonly requires?: { elicitation?: boolean; sampling?: boolean }
  readonly execute?: unknown
  (ctx: ToolCtx<TElicits>): Operation<(input: I) => Operation<O>>
}

export type ToolInvocationResult<T = unknown> = {
  result: T
  exchange: ToolCallExchange
}

/**
 * Project an AgentCtx-ish object to the leaf ToolCtx surface. This helper keeps
 * legacy adapters working; the agent runtime uses a richer per-call projection
 * that also installs declared elicit metadata and a tool-local history array.
 */
export function projectToToolCtx(
  ctx: {
    elicit: ToolCtx['elicit']
    elicitDynamic?: ToolCtx['elicitDynamic']
    sample: ToolCtx['sample']
    notify: ToolCtx['notify']
    log?: ToolCtx['log']
  },
  history: Message[] = [],
): ToolCtx {
  return {
    history,
    elicit: ctx.elicit,
    elicitDynamic:
      ctx.elicitDynamic ??
      ((options) => ctx.elicit(options.key as never, { message: options.message } as never)),
    sample: ctx.sample,
    notify: ctx.notify,
    log: ctx.log ?? ((level, message) => ctx.notify(message, undefined, level)),
  } as ToolCtx
}
