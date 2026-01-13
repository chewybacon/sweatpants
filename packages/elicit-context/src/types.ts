/**
 * x-elicit-context Type Definitions
 *
 * Core types for the elicit-context specification.
 */

// Note: We avoid importing Zod types directly to maintain compatibility
// across Zod v3 and v4. Schema types are captured via generics.

/**
 * Definition of an elicit request/response pair with optional context.
 * 
 * Used in tool definitions to declare:
 * - What the user must respond with (response schema)
 * - What context data is sent to the plugin for rendering (context schema)
 * 
 * The schema types are generic to avoid Zod version coupling.
 * Use `z.infer` on the response/context schemas to get the TypeScript types.
 * 
 * @template TResponseSchema - The Zod schema type for response
 * @template TContextSchema - The Zod schema type for context (optional)
 */
export interface ElicitDefinition<
  TResponseSchema = unknown,
  TContextSchema = unknown
> {
  /** Schema for the user's response (what they return) - any Zod schema */
  response?: TResponseSchema
  
  /** Schema for context data sent to the plugin (what the tool provides for rendering) */
  context?: TContextSchema
}

/**
 * An elicit entry can be either:
 * - A bare Zod schema (simple case - just the response schema)
 * - An ElicitDefinition with optional response and context schemas
 * 
 * This allows both simple and advanced usage:
 * ```ts
 * .elicits({
 *   // Simple: just pass the response schema
 *   confirm: z.object({ ok: z.boolean() }),
 *   
 *   // Advanced: full definition with context
 *   pickFlight: {
 *     response: z.object({ flightId: z.string() }),
 *     context: z.object({ flights: z.array(FlightSchema) }),
 *   },
 * })
 * ```
 */
export type ElicitEntry<TResponseSchema = unknown, TContextSchema = unknown> =
  | TResponseSchema  // Bare schema (simple case)
  | ElicitDefinition<TResponseSchema, TContextSchema>  // Full definition

/**
 * Map of elicit keys to their definitions.
 * Used in .elicits() to define all possible elicitation points in a tool.
 */
export type ElicitsMap = Record<string, ElicitEntry<any, any>>

/**
 * Request object passed to plugin elicit handlers.
 * Contains everything the handler needs to render UI and collect response.
 * 
 * @template TContext - Type of the context data (inferred from tool's elicit definition)
 */
export interface ElicitRequest<TContext = Record<string, unknown>> {
  /** The elicit key (e.g., 'pickFlight') */
  key: string
  
  /** Clean message (x-elicit-context boundary stripped) */
  message: string
  
  /** Extracted and typed context data from x-elicit-context */
  context: TContext
  
  /** Unique ID for this elicitation (for correlation with responses) */
  elicitId: string
  
  /** JSON Schema for the expected response */
  schema: Record<string, unknown>
}

/**
 * Options passed to ctx.elicit() in tool execution.
 * 
 * @template TContext - Type of the context data
 */
export type ElicitOptions<TContext = Record<string, unknown>> = {
  /** Human-readable message */
  message: string
} & TContext  // Context fields are spread directly

/**
 * JSON Schema type (for schema extension)
 */
export type JsonSchema = Record<string, unknown>

/**
 * Encoded elicit context in the wire format.
 */
export interface EncodedElicitContext {
  /** Message with x-elicit-context boundary appended */
  message: string
  
  /** Schema with x-elicit-context extension */
  schema: JsonSchema
}

/**
 * Decoded elicit context after extraction.
 */
export interface DecodedElicitContext<TContext = Record<string, unknown>> {
  /** Clean message (boundary stripped) */
  message: string
  
  /** Extracted context data */
  context: TContext
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Helper type to extract the output type from any Zod-like schema.
 * Works with both Zod v3 and v4 by using structural typing.
 * 
 * Zod schemas have an `_output` property that holds the output type.
 */
type InferZodOutput<T> = T extends { _output: infer O } ? O : unknown

/**
 * Extract the response type from an ElicitEntry (bare schema or definition).
 * Works by inferring the Zod output type from the response schema.
 */
export type ExtractElicitResponse<T> = T extends ElicitDefinition<infer TSchema, any>
  ? InferZodOutput<TSchema>
  : InferZodOutput<T>  // Bare schema case

/**
 * Extract the context type from an ElicitEntry.
 * Returns empty object type if no context defined or if it's a bare schema.
 */
export type ExtractElicitContext<T> = T extends ElicitDefinition<any, infer TSchema>
  ? TSchema extends undefined
    ? {} // eslint-disable-line @typescript-eslint/no-empty-object-type
    : InferZodOutput<TSchema>
  : {}  // Bare schema has no context

/**
 * Extract the response schema from an ElicitEntry.
 */
export type ExtractElicitResponseSchema<T> = T extends ElicitDefinition<infer TSchema, any>
  ? TSchema
  : T  // Bare schema is the response schema

/**
 * Extract the context schema from an ElicitEntry (if present).
 */
export type ExtractElicitContextSchema<T> = T extends ElicitDefinition<any, infer TSchema>
  ? TSchema
  : undefined  // Bare schema has no context
