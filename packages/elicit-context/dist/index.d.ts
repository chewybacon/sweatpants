import { z } from 'zod';

/**
 * x-elicit-context Type Definitions
 *
 * Core types for the elicit-context specification.
 */

/**
 * Definition of an elicit request/response pair with optional context.
 *
 * Used in tool definitions to declare:
 * - What the user must respond with (response schema)
 * - What context data is sent to the plugin for rendering (context schema)
 */
interface ElicitDefinition<TResponse = unknown, TContext = unknown> {
    /** Schema for the user's response (what they return) */
    response: z.ZodType<TResponse>;
    /** Schema for context data sent to the plugin (what the tool provides for rendering) */
    context?: z.ZodType<TContext>;
}
/**
 * Map of elicit keys to their definitions.
 * Used in .elicits() to define all possible elicitation points in a tool.
 */
type ElicitsMap = Record<string, ElicitDefinition<any, any>>;
/**
 * Request object passed to plugin elicit handlers.
 * Contains everything the handler needs to render UI and collect response.
 *
 * @template TContext - Type of the context data (inferred from tool's elicit definition)
 */
interface ElicitRequest<TContext = Record<string, unknown>> {
    /** The elicit key (e.g., 'pickFlight') */
    key: string;
    /** Clean message (x-elicit-context boundary stripped) */
    message: string;
    /** Extracted and typed context data from x-elicit-context */
    context: TContext;
    /** Unique ID for this elicitation (for correlation with responses) */
    elicitId: string;
    /** JSON Schema for the expected response */
    schema: Record<string, unknown>;
}
/**
 * Options passed to ctx.elicit() in tool execution.
 *
 * @template TContext - Type of the context data
 */
type ElicitOptions<TContext = Record<string, unknown>> = {
    /** Human-readable message */
    message: string;
} & TContext;
/**
 * JSON Schema type (for schema extension)
 */
type JsonSchema = Record<string, unknown>;
/**
 * Encoded elicit context in the wire format.
 */
interface EncodedElicitContext {
    /** Message with x-elicit-context boundary appended */
    message: string;
    /** Schema with x-elicit-context extension */
    schema: JsonSchema;
}
/**
 * Decoded elicit context after extraction.
 */
interface DecodedElicitContext<TContext = Record<string, unknown>> {
    /** Clean message (boundary stripped) */
    message: string;
    /** Extracted context data */
    context: TContext;
}

/**
 * Encoding utilities for x-elicit-context specification.
 *
 * Encodes context data into MCP elicit requests using two mechanisms:
 * 1. Schema extension (x-elicit-context field) - primary
 * 2. Message boundary encoding - fallback for compatibility
 */

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
declare function encodeElicitContext<TContext = Record<string, unknown>>(message: string, context: TContext, schema: JsonSchema): EncodedElicitContext;

/**
 * Decoding utilities for x-elicit-context specification.
 *
 * Extracts context data from MCP elicit requests and cleans messages.
 */

/**
 * Strip x-elicit-context boundary from message.
 *
 * Removes the boundary section to get the clean human-readable message.
 *
 * @param message - Message with potential boundary encoding
 * @returns Clean message without boundary
 */
declare function stripMessageContext(message: string): string;
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
declare function decodeElicitContext<TContext = Record<string, unknown>>(message: string, schema: JsonSchema): DecodedElicitContext<TContext>;

export { type DecodedElicitContext, type ElicitDefinition, type ElicitOptions, type ElicitRequest, type ElicitsMap, type EncodedElicitContext, type JsonSchema, decodeElicitContext, encodeElicitContext, stripMessageContext };
