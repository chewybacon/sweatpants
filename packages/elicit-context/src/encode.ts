import type { JsonSchema, EncodedElicitContext } from './types.ts'

/** Encodes context only in the canonical `x-elicit-context` schema extension. */
export function encodeElicitContext<TContext = Record<string, unknown>>(
  message: string,
  context: TContext,
  schema: JsonSchema,
): EncodedElicitContext {
  return {
    message,
    schema: {
      ...schema,
      'x-elicit-context': context,
    },
  }
}
