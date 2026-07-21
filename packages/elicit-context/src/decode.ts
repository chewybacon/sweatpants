import type { JsonSchema, DecodedElicitContext } from './types.ts'

/** Decodes context only from the canonical `x-elicit-context` schema extension. */
export function decodeElicitContext<TContext = Record<string, unknown>>(
  message: string,
  schema: JsonSchema,
): DecodedElicitContext<TContext> {
  const value = schema['x-elicit-context']
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return { message, context: context as TContext }
}
