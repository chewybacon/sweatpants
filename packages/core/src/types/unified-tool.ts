/**
 * Unified tool model type helpers.
 *
 * These are re-exported from @sweatpants/core so declared keyed elicit surfaces
 * can infer response/context types without depending directly on the framework
 * or elicit-context package.
 */

export type ElicitMode = 'form' | 'url'
export type InterruptReason = 'tool_call' | 'input_required' | 'confirmation' | `${string}:${string}`

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
