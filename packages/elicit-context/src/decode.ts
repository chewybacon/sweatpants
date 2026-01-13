/**
 * Decoding utilities for x-elicit-context specification.
 * 
 * Extracts context data from MCP elicit requests and cleans messages.
 */
import type { JsonSchema, DecodedElicitContext } from './types.ts'

/**
 * Extract context from a message's boundary encoding.
 * 
 * Looks for the `--x-elicit-context: application/json` boundary and parses
 * the JSON content that follows.
 * 
 * @param message - Message with potential boundary encoding
 * @returns Parsed context or null if no boundary found
 */
function extractContextFromMessage(message: string): Record<string, unknown> | null {
  const boundaryMarker = '\n--x-elicit-context: application/json\n'
  const boundaryIndex = message.indexOf(boundaryMarker)
  
  if (boundaryIndex === -1) {
    return null
  }
  
  try {
    const contextJson = message.slice(boundaryIndex + boundaryMarker.length)
    return JSON.parse(contextJson) as Record<string, unknown>
  } catch {
    // Invalid JSON in boundary - return null
    return null
  }
}

/**
 * Strip x-elicit-context boundary from message.
 * 
 * Removes the boundary section to get the clean human-readable message.
 * 
 * @param message - Message with potential boundary encoding
 * @returns Clean message without boundary
 */
export function stripMessageContext(message: string): string {
  const boundaryIndex = message.indexOf('\n--x-elicit-context:')
  return boundaryIndex === -1 ? message : message.slice(0, boundaryIndex).trim()
}

/**
 * Decode context from an elicit request.
 * 
 * Extraction priority:
 * 1. Schema extension (`x-elicit-context` field) - primary
 * 2. Message boundary encoding - fallback
 * 3. Empty object if no context found
 * 
 * @param message - Elicit message (may have boundary encoding)
 * @param schema - JSON Schema (may have x-elicit-context extension)
 * @returns Decoded context and cleaned message
 * 
 * @example
 * ```typescript
 * const { message, context } = decodeElicitContext(
 *   messageWithBoundary,
 *   schemaWithExtension
 * )
 * 
 * // message is cleaned (boundary removed)
 * // context is extracted (typed by caller)
 * ```
 */
export function decodeElicitContext<TContext = Record<string, unknown>>(
  message: string,
  schema: JsonSchema
): DecodedElicitContext<TContext> {
  // Try schema extension first (clean JSON, preferred)
  let context: unknown = schema['x-elicit-context']
  
  // Fall back to message boundary if schema extension not found
  if (context === undefined) {
    context = extractContextFromMessage(message)
  }
  
  // Default to empty object if no context found
  if (context === null || context === undefined) {
    context = {}
  }
  
  // Clean the message
  const cleanMessage = stripMessageContext(message)
  
  return {
    message: cleanMessage,
    context: context as TContext,
  }
}
