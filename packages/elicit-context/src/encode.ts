/**
 * Encoding utilities for x-elicit-context specification.
 * 
 * Encodes context data into MCP elicit requests using two mechanisms:
 * 1. Schema extension (x-elicit-context field) - primary
 * 2. Message boundary encoding - fallback for compatibility
 */
import type { JsonSchema, EncodedElicitContext } from './types.ts'

/**
 * Encode context data into an elicit request.
 * 
 * Adds context in two places for maximum compatibility:
 * - Primary: `x-elicit-context` field in JSON Schema
 * - Fallback: Message boundary encoding for clients that don't support schema extensions
 * 
 * @param message - Human-readable message
 * @param context - Context data to encode
 * @param schema - JSON Schema for the response
 * @returns Encoded message and schema with context embedded
 * 
 * @example
 * ```typescript
 * const encoded = encodeElicitContext(
 *   'Select a flight',
 *   { flights: [...], currency: 'USD' },
 *   { type: 'object', properties: { flightId: { type: 'string' } } }
 * )
 * 
 * // encoded.schema has x-elicit-context extension
 * // encoded.message has boundary-encoded context appended
 * ```
 */
export function encodeElicitContext<TContext = Record<string, unknown>>(
  message: string,
  context: TContext,
  schema: JsonSchema
): EncodedElicitContext {
  // Add context to schema extension (primary mechanism)
  const schemaWithContext: JsonSchema = {
    ...schema,
    'x-elicit-context': context,
  }

  // Add context to message boundary (fallback mechanism)
  const contextJson = JSON.stringify(context)
  const messageWithContext = `${message}\n\n--x-elicit-context: application/json\n${contextJson}`

  return {
    message: messageWithContext,
    schema: schemaWithContext,
  }
}
