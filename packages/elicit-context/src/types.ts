/**
 * x-elicit-context Type Definitions
 *
 * Core types for the elicit-context specification.
 */
import type { z } from 'zod'

/**
 * Definition of an elicit request/response pair with optional context.
 * 
 * Used in tool definitions to declare:
 * - What the user must respond with (response schema)
 * - What context data is sent to the plugin for rendering (context schema)
 */
export interface ElicitDefinition<TResponse = unknown, TContext = unknown> {
  /** Schema for the user's response (what they return) */
  response: z.ZodType<TResponse>
  
  /** Schema for context data sent to the plugin (what the tool provides for rendering) */
  context?: z.ZodType<TContext>
}

/**
 * Map of elicit keys to their definitions.
 * Used in .elicits() to define all possible elicitation points in a tool.
 */
export type ElicitsMap = Record<string, ElicitDefinition<any, any>>

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
