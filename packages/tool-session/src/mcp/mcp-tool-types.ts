/**
 * MCP Tool Types
 *
 * Unified type definitions for MCP (Model Context Protocol) tools.
 * Provides a generator-based execution model with:
 * - LLM backchannel (sampling)
 * - User backchannel (elicitation)
 * - Tool-local conversation state for multi-step work
 *
 * ## MCP Primitives Mapping
 *
 * | MCP Method            | Our Primitive       | Description                    |
 * |-----------------------|---------------------|--------------------------------|
 * | elicitation/create    | ctx.elicit()        | Request structured user input  |
 * | sampling/createMessage| ctx.sample()        | Request LLM completion         |
 * | notifications/message | ctx.log()           | Send log message               |
 * | notifications/progress| ctx.notify()        | Send progress update           |
 *
 * ## Mental Model
 *
 * Tool calls split execution away from the main LLM timeline. Each tool call:
 * - Receives conversation context
 * - Runs a server-driven generator
 * - Can sample or elicit during that generator
 * - Returns a single result to the caller
 *
 * ```
 * Main Timeline
 *     |
 *     +-- tool_call --> tool execution --> result
 *     |                      |
 *     |                      +-- sample (LLM backchannel)
 *     |                      +-- elicit (user backchannel)
 *     |
 *     v continues
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from "effection";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ElicitsMap,
  LogLevel,
  ExtractElicitResponse,
  ExtractElicitContextInput,
  ToolSamplingCtx,
  ToolElicitResult,
} from "@sweatpants/agent-sdk";
import type { ChatMessage } from "@sweatpants/chat-contract";

// Re-export MCP types for convenience
export type {
  McpMessage,
  McpContentBlock,
  McpTextContent,
  McpToolUseContent,
  McpToolResultContent,
} from "./protocol/types.js";

// =============================================================================
// ELICITATION TYPES (shared)
// =============================================================================

/**
 * Elicitation exchange - captures an elicitation as a request/response message pair.
 *
 * Uses MCP content block format:
 * - Request: assistant message with tool_use content block
 * - Response: user message with tool_result content block
 *
 * This enables tools to accumulate elicitation exchanges as conversation history
 * for sampling. The exchange captures:
 * - The context passed to elicit() (fully typed)
 * - The request as an assistant message with tool_use
 * - The response as a user message with tool_result
 *
 * @template TContext - The type of context passed to elicit()
 *
 * @example
 * ```typescript
 * const result = yield* ctx.elicit('pickMove', { message: 'Your turn!', board, moveHistory })
 *
 * if (result.action === 'accept') {
 *   // Safe default - no context in arguments
 *   history.push(...result.exchange.messages)
 *
 *   // Or with explicit derived context
 *   history.push(...result.exchange.withArguments((ctx) => ({
 *     boardState: formatBoard(ctx.board),
 *   })))
 * }
 * ```
 */

/**
 * Handler-layer configuration for an unkeyed elicitation request.
 */
export interface ClientElicitConfig<T> {
  /** Human-readable message to display to the user */
  message: string;

  /**
   * Standard Schema for the expected response.
   *
   * Note: MCP elicitation only supports flat objects with primitive properties:
   * - string (with optional format: email, uri, date, date-time)
   * - number / integer (with optional min/max)
   * - boolean
   * - enum (string enums only)
   *
   * Nested objects and arrays are NOT supported.
   */
  schema: StandardSchemaV1<unknown, T>;
}

// =============================================================================
// SAMPLE EXCHANGE TYPE
// =============================================================================

/**
 * Sampling exchange - captures a sampling interaction as accumulate-able messages.
 *
 * An exchange represents the interaction for context history purposes.
 * It's not a pedantic record of what went over the wire - it models the
 * data flow correctly so the context window makes sense.
 *
 * Uses MCP content block format:
 * - Raw sampling: 2 messages [user, assistant]
 * - Structured output: 3 messages [user, assistant (tool_use), user (tool_result)]
 *
 * For structured output, the "response" is split into 2 messages to be MCP-compliant
 * (tool_use MUST be followed by tool_result).
 *
 * @template TParsed - The type of parsed structured output (undefined for raw sampling)
 *
 * @example Raw sampling
 * ```typescript
 * const result = yield* ctx.sample({ prompt: 'Analyze this' })
 * history.push(...result.exchange.messages) // 2 messages
 * ```
 *
 * @example Structured output
 * ```typescript
 * const result = yield* ctx.sample({
 *   prompt: 'Pick a move',
 *   schema: z.object({ cell: z.number() })
 * })
 * if (result.parsed) {
 *   history.push(...result.exchange.messages) // 3 messages
 *   console.log('Move:', result.exchange.parsed.cell)
 * }
 * ```
 */

// =============================================================================
// ELICITATION SURFACE (finite, typed keys for bridgeable tools)
// =============================================================================

/**
 * A map of elicitation keys to their definitions (response + optional context schemas).
 *
 * Used with `.elicits({...})` to declare a finite elicitation surface.
 *
 * @example With context
 * ```typescript
 * const tool = createTool('book_flight')
 *   .elicits({
 *     pickFlight: {
 *       response: z.object({ flightId: z.string() }),
 *       context: z.object({ flights: z.array(FlightSchema) }),
 *     },
 *   })
 * ```
 *
 * @example Without context
 * ```typescript
 * const tool = createTool('confirm')
 *   .elicits({
 *     confirm: {
 *       response: z.object({ ok: z.boolean() }),
 *     },
 *   })
 * ```
 */
/**
 * Structured elicitation ID for correlation and logging.
 * Simple key in API, structured id under the hood.
 */
export interface ElicitId {
  toolName: string;
  key: string;
  callId: string;
  seq: number;
}

/**
 * Request object passed to elicitation handlers.
 *
 * Context data is carried directly by the internal client elicitation request;
 * protocol adapters may encode it at their external wire boundary.
 */
export interface ElicitRequest<
  TKey extends string = string,
  TSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
  /** Structured id for correlation/logging */
  id: ElicitId;

  /** The elicitation key (matches `.elicits()` declaration) */
  key: TKey;

  /** Tool name */
  toolName: string;

  /** Tool call id */
  callId: string;

  /** Sequence number for this elicitation within the call */
  seq: number;

  /**
   * Human-readable message to display to the user.
   *
   * Human-readable message authored by the producer; context is carried separately.
   */
  message: string;

  /**
   * Authored response schema in Standard Schema and portable JSON forms.
   */
  schema: {
    standard: TSchema;
    json: Record<string, unknown>;
  };

  /** Original tool params (for context) */
  params?: unknown;

  /** Optional context data for richer UI */
  context?: unknown;
}

// =============================================================================
// LOGGING TYPES
// =============================================================================

// =============================================================================
// EXECUTION LIMITS
// =============================================================================

/**
 * Limits configuration for tool execution.
 */
export interface McpToolLimits {
  /** Maximum total tokens across all tool-internal sampling work. */
  maxTokens?: number;
}

// =============================================================================
// MCP TOOL CONTEXT
// =============================================================================

/**
 * Context available in MCP tool execution.
 *
 * Provides primitives for:
 * - Managing current conversation
 * - LLM backchannel (sample)
 * - User input backchannel (elicit)
 *
 * @example
 * ```typescript
 * createTool('analyze')
 *   .execute(function* (params, ctx) {
 *     // Auto-tracked conversation
 *     const analysis = yield* ctx.sample({ prompt: 'Analyze...' })
 *
 *     // User confirmation
 *     const choice = yield* ctx.elicit('confirm', {
 *       message: 'Confirm?',
 *     })
 *
 *     return { analysis, confirmed: choice.action === 'accept' }
 *   })
 * ```
 */
export interface McpToolContext extends ToolSamplingCtx<ChatMessage> {
  // ---------------------------------------------------------------------------
  // Current tool-local state
  // ---------------------------------------------------------------------------

  /** Scope-owned cancellation signal for abort-aware external APIs. */
  readonly signal: AbortSignal;

  /**
   * Messages in this tool context's conversation.
   * Auto-updated when using `sample({ prompt })` form.
   * Read-only view - use sample/elicit to modify.
   */
  readonly messages: readonly ChatMessage[];

  // ---------------------------------------------------------------------------
  // Authored sampling is inherited from Agent SDK and specialized to canonical ChatMessage.

  // User backchannel
  // ---------------------------------------------------------------------------

  /**
   * Request structured input from the user.
   *
   * Maps to MCP: `elicitation/create`
   *
   * @example
   * ```typescript
   * const choice = yield* ctx.elicit({
   *   message: 'Pick an option:',
   *   schema: z.object({
   *     option: z.enum(['a', 'b', 'c'])
   *   })
   * })
   *
   * if (choice.action === 'accept') {
   *   console.log('User chose:', choice.content.option)
   * }
   * ```
   */
  elicit<T>(config: ClientElicitConfig<T>): Operation<ToolElicitResult<unknown, T>>;

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  /**
   * Send a log message to the client.
   *
   * Maps to MCP: `notifications/message`
   */
  log(level: LogLevel, message: string): Operation<void>;

  /**
   * Send a progress notification to the client.
   *
   * Maps to MCP: `notifications/progress`
   */
  notify(message: string, progress?: number): Operation<void>;
}

// =============================================================================
// KEYED ELICITATION CONTEXT (for bridgeable tools)
// =============================================================================

/**
 * MCP tool context with typed, keyed elicitation.
 *
 * Used when a tool declares `.elicits({...})` to enable exhaustive
 * UI bridging with type safety.
 *
 * @template TElicits - Map of elicitation keys to their Standard Schema values
 *
 * @example
 * ```typescript
 * // Tool declares elicitation surface
 * const tool = createTool('book_flight')
 *   .elicits({
 *     pickFlight: z.object({ flightId: z.string() }),
 *     confirm: z.object({ ok: z.boolean() }),
 *   })
 *   .execute(function* (params, ctx) {
 *     // ctx.elicit is keyed and type-safe
 *     const picked = yield* ctx.elicit('pickFlight', { message: 'Pick a flight' })
 *     const ok = yield* ctx.elicit('confirm', { message: 'Confirm?' })
 *     return { picked, ok }
 *   })
 * ```
 */
export interface McpToolContextWithElicits<
  TElicits extends ElicitsMap,
> extends ToolSamplingCtx<ChatMessage> {
  // ---------------------------------------------------------------------------
  // Current tool-local state - same as McpToolContext
  // ---------------------------------------------------------------------------

  /** Scope-owned cancellation signal for abort-aware external APIs. */
  readonly signal: AbortSignal;
  readonly messages: readonly ChatMessage[];

  // ---------------------------------------------------------------------------
  // Authored sampling is inherited from Agent SDK and specialized to canonical ChatMessage.

  // User backchannel - KEYED elicitation
  // ---------------------------------------------------------------------------

  /**
   * Request structured input from the user using a declared elicitation key.
   *
   * The key must exist in the tool's `.elicits({...})` declaration.
   * The schema is derived from the key, enabling type-safe UI bridging.
   *
   * Context data is typed from the elicit definition and spread directly in options.
   *
   * @param key - Elicitation key declared in `.elicits()`
   * @param options - Options including message and typed context data
   * @returns The user's response (accept/decline/cancel)
   *
   * @example
   * ```typescript
   * // Simple elicitation (no context)
   * const result = yield* ctx.elicit('confirm', { message: 'Proceed?' })
   *
   * // With typed context data for the UI
   * const flights = searchFlights(from, to)
   * const result = yield* ctx.elicit('pickFlight', {
   *   message: 'Select your flight',
   *   flights,  // Typed from context schema
   *   currency: 'USD',
   * })
   * ```
   */
  elicit<K extends keyof TElicits & string>(
    key: K,
    options: ExtractElicitContextInput<TElicits[K]> extends undefined
      ? { message: string }
      : { message: string; context: ExtractElicitContextInput<TElicits[K]> },
  ): Operation<
    ToolElicitResult<ExtractElicitContextInput<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>
  >;

  // ---------------------------------------------------------------------------
  // Logging - same as McpToolContext
  // ---------------------------------------------------------------------------

  log(level: LogLevel, message: string): Operation<void>;
  notify(message: string, progress?: number): Operation<void>;
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error thrown when MCP client doesn't support a required capability.
 */
export class McpCapabilityError extends Error {
  constructor(
    public readonly capability: "elicitation" | "sampling",
    message: string,
  ) {
    super(message);
    this.name = "McpCapabilityError";
  }
}

/**
 * Error thrown when user declines an elicitation.
 */
export class ElicitationDeclinedError extends Error {
  constructor(message = "User declined the elicitation request") {
    super(message);
    this.name = "ElicitationDeclinedError";
  }
}

/**
 * Error thrown when user cancels an elicitation.
 */
export class ElicitationCancelledError extends Error {
  constructor(message = "User cancelled the elicitation request") {
    super(message);
    this.name = "ElicitationCancelledError";
  }
}

/**
 * Error thrown when the tool token budget is exceeded.
 */
export class McpToolTokenError extends Error {
  constructor(
    public readonly used: number,
    public readonly budget: number,
  ) {
    super(`Tool execution used ${used} tokens, exceeding budget of ${budget}`);
    this.name = "McpToolTokenError";
  }
}

/**
 * Error thrown on MCP disconnect.
 */
export class McpDisconnectError extends Error {
  constructor(message = "MCP client disconnected") {
    super(message);
    this.name = "McpDisconnectError";
  }
}
