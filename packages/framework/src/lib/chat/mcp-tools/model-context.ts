/**
 * Model Context Transport Utilities
 *
 * Handles encoding and decoding of context data for MCP elicitation requests.
 * Context data is transported in two locations for maximum compatibility:
 *
 * 1. **Schema extension**: `x-elicit-context` field (primary, clean JSON)
 * 2. **Message boundary**: MIME-style encoded section (fallback)
 *
 * This enables:
 * - Plugin handlers to receive rich typed context
 * - External MCP clients to show human-readable message + basic form
 * - Graceful degradation when schema extensions are stripped
 *
 * @packageDocumentation
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Schema extension key for context data.
 * Uses `x-` prefix following vendor extension conventions (OpenAPI, etc.).
 * Must match the key used by @sweatpants/elicit-context encoder.
 */
export const MODEL_CONTEXT_SCHEMA_KEY = 'x-elicit-context'

/**
 * Message boundary marker for context data.
 * Format: `--x-elicit-context: <mime-type>`
 * Must match the boundary used by @sweatpants/elicit-context encoder.
 */
export const MODEL_CONTEXT_BOUNDARY = '\n--x-elicit-context:'

/**
 * Default MIME type for context data.
 */
export const MODEL_CONTEXT_MIME_TYPE = 'application/json'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for encoding elicit request with context.
 */
export interface EncodeElicitContextOptions {
  /** Human-readable message */
  message: string
  /** JSON Schema for the response */
  schema: Record<string, unknown>
  /** Context data to embed */
  context?: Record<string, unknown>
}

/**
 * Result of encoding elicit request with context.
 */
export interface EncodedElicitContext {
  /** Message with optional boundary-encoded context */
  message: string
  /** Schema with x-model-context extension */
  schema: Record<string, unknown>
}

/**
 * Extracted context from an elicit request.
 */
export interface ExtractedModelContext {
  /** The context data (empty object if none found) */
  data: Record<string, unknown>
  /** Where the context was found */
  source: 'schema' | 'message' | 'none'
  /** Original message with context section stripped */
  cleanMessage: string
}

// =============================================================================
// ENCODING
// =============================================================================

/**
 * Encode context data into an elicit request.
 *
 * Embeds context in both schema (as `x-model-context`) and message
 * (as boundary-encoded section) for maximum compatibility.
 *
 * @param options - Encoding options
 * @returns Encoded message and schema
 *
 * @example
 * ```typescript
 * const { message, schema } = encodeElicitContext({
 *   message: 'Select a flight:\n1. SkyHigh $299\n2. CloudAir $349',
 *   schema: { type: 'object', properties: { flightId: { type: 'string' } } },
 *   context: { flights: [...] },
 * })
 * ```
 */
export function encodeElicitContext(options: EncodeElicitContextOptions): EncodedElicitContext {
  const { message, schema, context } = options

  // No context to encode
  if (!context || Object.keys(context).length === 0) {
    return { message, schema }
  }

  // Encode context into schema
  const schemaWithContext: Record<string, unknown> = {
    ...schema,
    [MODEL_CONTEXT_SCHEMA_KEY]: context,
  }

  // Encode context into message (boundary format)
  const contextJson = JSON.stringify(context)
  const messageWithContext = `${message}\n\n${MODEL_CONTEXT_BOUNDARY} ${MODEL_CONTEXT_MIME_TYPE}\n${contextJson}`

  return {
    message: messageWithContext,
    schema: schemaWithContext,
  }
}

// =============================================================================
// DECODING
// =============================================================================

/**
 * Extract context data from an elicit request.
 *
 * Tries schema extension first (preferred), falls back to message parsing.
 *
 * @param message - The elicit message (may contain boundary-encoded context)
 * @param schema - The JSON schema (may contain x-model-context)
 * @returns Extracted context and clean message
 *
 * @example
 * ```typescript
 * const { data, cleanMessage, source } = extractModelContext(
 *   req.message,
 *   req.schema.json
 * )
 * const flights = data.flights as Flight[]
 * ```
 */
export function extractModelContext(
  message: string,
  schema: Record<string, unknown>
): ExtractedModelContext {
  // Try schema first (primary source)
  const schemaContext = schema[MODEL_CONTEXT_SCHEMA_KEY]
  if (schemaContext && typeof schemaContext === 'object') {
    return {
      data: schemaContext as Record<string, unknown>,
      source: 'schema',
      cleanMessage: stripMessageContext(message),
    }
  }

  // Try message parsing (fallback)
  const messageContext = parseMessageContext(message)
  if (messageContext) {
    return {
      data: messageContext.context,
      source: 'message',
      cleanMessage: messageContext.cleanMessage,
    }
  }

  // No context found
  return {
    data: {},
    source: 'none',
    cleanMessage: message,
  }
}

/**
 * Parse context data from a message with boundary encoding.
 *
 * @param message - Message that may contain boundary-encoded context
 * @returns Parsed context and clean message, or null if no context found
 */
export function parseMessageContext(
  message: string
): { context: Record<string, unknown>; cleanMessage: string } | null {
  const boundaryIndex = message.indexOf(MODEL_CONTEXT_BOUNDARY)
  if (boundaryIndex === -1) {
    return null
  }

  // Split message at boundary
  const cleanMessage = message.substring(0, boundaryIndex).trimEnd()
  
  // contextPart starts with the boundary marker (which includes leading \n)
  // Skip the leading newline to get the boundary line starting with '--'
  const contextPart = message.substring(boundaryIndex + 1) // skip leading \n

  // Parse the boundary line to get MIME type
  // Format: "--x-elicit-context: application/json\n{json}"
  const firstNewline = contextPart.indexOf('\n')
  if (firstNewline === -1) {
    return null
  }

  const boundaryLine = contextPart.substring(0, firstNewline)
  // Boundary line is "--x-elicit-context: application/json"
  // We need to extract just the MIME type after the colon
  const colonIndex = boundaryLine.indexOf(':')
  if (colonIndex === -1) {
    return null
  }
  const mimeType = boundaryLine.substring(colonIndex + 1).trim()

  // Get the context data (everything after the boundary line)
  const contextData = contextPart.substring(firstNewline + 1).trim()

  // Parse based on MIME type
  if (mimeType === MODEL_CONTEXT_MIME_TYPE || mimeType.startsWith('application/json')) {
    try {
      const parsed = JSON.parse(contextData)
      if (typeof parsed === 'object' && parsed !== null) {
        return { context: parsed, cleanMessage }
      }
    } catch {
      // Invalid JSON, return null
      return null
    }
  }

  // Unsupported MIME type
  return null
}

/**
 * Strip context section from a message (if present).
 *
 * @param message - Message that may contain boundary-encoded context
 * @returns Message with context section removed
 */
export function stripMessageContext(message: string): string {
  const boundaryIndex = message.indexOf(MODEL_CONTEXT_BOUNDARY)
  if (boundaryIndex === -1) {
    return message
  }
  return message.substring(0, boundaryIndex).trimEnd()
}

// =============================================================================
// HELPERS FOR PLUGIN AUTHORS
// =============================================================================

/**
 * Helper to get context data from an elicit request.
 *
 * This is the recommended way for plugin handlers to access context data.
 *
 * @param req - The elicit request from plugin handler
 * @returns Context data object
 *
 * @example
 * ```typescript
 * pickFlight: function* (req, ctx) {
 *   const { flights } = getElicitContext(req)
 *   const result = yield* ctx.render(FlightList, { flights, message: req.message })
 *   return { action: 'accept', content: result }
 * }
 * ```
 */
export function getElicitContext<T extends Record<string, unknown> = Record<string, unknown>>(
  req: { message: string; schema: { json: Record<string, unknown> } }
): T {
  const { data } = extractModelContext(req.message, req.schema.json)
  return data as T
}
