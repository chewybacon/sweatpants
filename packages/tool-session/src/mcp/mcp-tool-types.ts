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
import type { Json } from "@sweatpants/foundation";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  ElicitDefinition,
  ElicitsMap as BaseElicitsMap,
  ExtractElicitResponse,
  ExtractElicitContext,
  ExtractElicitResponseSchema,
  ExtractElicitContextSchema,
  SampleExchange,
  ToolElicitResult as CoreToolElicitResult,
  WireElicitResult as CoreWireElicitResult,
  ToolMessage,
} from "@sweatpants/agent-sdk";
import type { ExtendedMessage, Message } from "../messages.ts";

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
 * Result of an elicitation request.
 *
 * MCP elicitation has three response actions:
 * - `accept`: User submitted data (content and exchange available)
 * - `decline`: User explicitly declined (clicked "No", "Reject", etc.)
 * - `cancel`: User dismissed without choosing (closed dialog, pressed Escape)
 *
 * @template TContext - The type of context passed to elicit()
 * @template TResponse - The type of the user's response
 */
export type ToolElicitResult<TContext, TResponse> = CoreToolElicitResult<TContext, TResponse>;

/**
 * Wire elicit result without exchange.
 * Used by plugin handlers and transport layers.
 */
export type WireElicitResult<TResponse = unknown> = CoreWireElicitResult<TResponse>;

/**
 * Handler-layer configuration for an unkeyed elicitation request.
 */
export interface ClientElicitConfig<T> {
  /** Message to display to the user */
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

/**
 * Reserved tool name for structured output.
 * Clients can intercept this and use native provider implementations.
 */
export const SCHEMA_TOOL_NAME = "__schema__";

/**
 * Create a SampleExchange for raw sampling (no schema).
 *
 * @param promptText - The user's prompt text
 * @param responseText - The assistant's response text
 */
export function createRawSampleExchange(
  promptText: string,
  responseText: string,
): SampleExchange<undefined> {
  const request: ToolMessage & { role: "user" } = {
    role: "user",
    content: [{ type: "text", text: promptText }],
  };
  const response: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: [{ type: "text", text: responseText }],
  };
  return {
    request,
    response,
    messages: [request, response],
    parsed: undefined,
  };
}

/**
 * Create a SampleExchange for structured output (with schema).
 * Uses the __schema__ meta-tool pattern with 3 messages.
 *
 * @param promptText - The user's prompt text
 * @param parsed - The parsed/validated data
 * @param toolCallId - Unique ID for the tool call
 */
export function createStructuredSampleExchange<T>(
  promptText: string,
  parsed: T,
  toolCallId: string,
): SampleExchange<T> {
  const request: ToolMessage & { role: "user" } = {
    role: "user",
    content: [{ type: "text", text: promptText }],
  };

  // Assistant responds with __schema__ tool_use
  // Input is intentionally blank; parsed data is echoed in tool_result
  const toolUse: ToolMessage & { role: "assistant" } = {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: toolCallId,
        name: SCHEMA_TOOL_NAME,
        input: {},
      },
    ],
  };

  // Construct tool_result with the parsed data echoed back
  // This keeps MCP compliance while "virtually" moving input to the result
  // Parsed data also stays on the exchange for consumers
  const toolResult: ToolMessage & { role: "user" } = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: toolCallId,
        content: [{ type: "text", text: JSON.stringify(parsed) }],
      },
    ],
  };

  return {
    request,
    response: toolUse,
    messages: [request, toolUse, toolResult],
    parsed,
  };
}

// =============================================================================
// ELICITATION SURFACE (finite, typed keys for bridgeable tools)
// =============================================================================

/**
 * Re-export ElicitDefinition from elicit-context package.
 */
export type { ElicitDefinition };

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
export type ElicitsMap = BaseElicitsMap;

// Re-export type helpers from elicit-context package
export type {
  ExtractElicitResponse,
  ExtractElicitContext,
  ExtractElicitResponseSchema,
  ExtractElicitContextSchema,
};

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
 * Context data (e.g., flights, seatMap) is transported via the `x-elicit-context`
 * extension in the schema and as a boundary-encoded section in the message.
 * Use `getElicitContext(req)` to extract it.
 *
 * Use the sibling `getElicitContext` helper to read this extension.
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
   * Message to display to the user.
   *
   * May contain a boundary-encoded context section at the end.
   * Use `getElicitContext(req)` to extract context and get clean message.
   */
  message: string;

  /**
   * Schema in both forms.
   *
   * The `json` schema may contain `x-elicit-context` extension with context data.
   * Use `getElicitContext(req)` to extract it.
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
// SAMPLING TYPES
// =============================================================================

/**
 * Model preferences for sampling requests.
 *
 * Used to guide the MCP client's model selection without requiring
 * the server to know about specific models.
 */
export interface ModelPreferences {
  /**
   * Model name hints (evaluated in order of preference).
   * These are substrings that can match model names flexibly.
   *
   * @example
   * ```typescript
   * hints: [
   *   { name: 'claude-3-sonnet' },  // Prefer Sonnet-class
   *   { name: 'claude' },           // Fall back to any Claude
   * ]
   * ```
   */
  hints?: Array<{ name: string }>;

  /** How important is minimizing cost? (0-1, higher = prefer cheaper) */
  costPriority?: number;

  /** How important is low latency? (0-1, higher = prefer faster) */
  speedPriority?: number;

  /** How important are advanced capabilities? (0-1, higher = prefer smarter) */
  intelligencePriority?: number;
}

// -----------------------------------------------------------------------------
// TOOL DEFINITIONS FOR SAMPLING
// -----------------------------------------------------------------------------

/**
 * Definition of a tool that can be called during sampling.
 *
 * Used with `ctx.sample({ tools: [...] })` to enable structured output
 * or multi-turn tool calling patterns within a tool.
 */
export interface SamplingToolDefinition {
  /** Tool name */
  name: string;

  /** Description for the LLM */
  description?: string;

  /**
   * Input schema as Standard Schema or raw JSON Schema.
   * First-party Zod schemas satisfy Standard Schema automatically.
   */
  inputSchema: StandardSchemaV1 | Record<string, unknown>;
}

/**
 * A tool call returned by the model during sampling.
 */
export interface SamplingToolCall {
  /** Unique ID for this tool call (for correlation with results) */
  id: string;

  /** Name of the tool being called */
  name: string;

  /** Model-authored arguments; only the authored tool schema may narrow them. */
  arguments: Json;
}

/**
 * Tool choice configuration for sampling.
 */
export type SamplingToolChoice = "auto" | "required" | "none";

// -----------------------------------------------------------------------------
// SAMPLE CONFIG BASE
// -----------------------------------------------------------------------------

/**
 * Base sample configuration (shared fields).
 */
interface SampleConfigBase {
  /** Optional system prompt override */
  systemPrompt?: string;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Model preferences for the client */
  modelPreferences?: ModelPreferences;
}

// -----------------------------------------------------------------------------
// SAMPLE CONFIG VARIANTS (mutually exclusive)
// -----------------------------------------------------------------------------

/**
 * Plain sample config - no schema or tools.
 */
interface SampleConfigPlain extends SampleConfigBase {
  schema?: never;
  tools?: never;
  toolChoice?: never;
}

/**
 * Sample config with structured output schema.
 * The response will be parsed and validated against the schema.
 *
 * @template T - The type of the parsed output
 */
interface SampleConfigWithSchema<T = unknown> extends SampleConfigBase {
  /**
   * Standard Schema for structured output.
   * The model's response will be parsed and validated against this schema.
   * Uses provider's native structured output when available.
   */
  schema: StandardSchemaV1<unknown, T>;
  tools?: never;
  toolChoice?: never;
}

/**
 * Sample config with tool definitions.
 * Enables the model to call tools, returning tool calls in the result.
 */
interface SampleConfigWithTools extends SampleConfigBase {
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[];

  /**
   * How the model should choose tools:
   * - 'auto': Model decides whether to call a tool (default)
   * - 'required': Model must call at least one tool
   * - 'none': Tools are provided for context but model cannot call them
   */
  toolChoice?: SamplingToolChoice;
  schema?: never;
}

// -----------------------------------------------------------------------------
// MESSAGE MODE VARIANTS
// -----------------------------------------------------------------------------

/**
 * Sample with auto-tracked prompt (appends to tool-local conversation state).
 */
interface SampleConfigPromptMode {
  /** The prompt to send (auto-tracked in tool-local conversation state) */
  prompt: string;
  messages?: never;
}

/**
 * Sample with explicit messages (full control).
 *
 * Supports ExtendedMessage to allow passing tool-call messages
 * (e.g., from elicit exchanges) as conversation history.
 */
interface SampleConfigMessagesMode {
  /** Explicit messages array (not auto-tracked). Supports canonical tool-call history. */
  messages: ExtendedMessage[];
  prompt?: never;
}

// -----------------------------------------------------------------------------
// COMBINED SAMPLE CONFIG TYPES
// -----------------------------------------------------------------------------

/** Plain sample with prompt */
export type SampleConfigPlainPrompt = SampleConfigPlain & SampleConfigPromptMode;

/** Plain sample with messages */
export type SampleConfigPlainMessages = SampleConfigPlain & SampleConfigMessagesMode;

/** Schema sample with prompt */
export type SampleConfigSchemaPrompt<T = unknown> = SampleConfigWithSchema<T> &
  SampleConfigPromptMode;

/** Schema sample with messages */
export type SampleConfigSchemaMessages<T = unknown> = SampleConfigWithSchema<T> &
  SampleConfigMessagesMode;

/** Tools sample with prompt */
export type SampleConfigToolsPrompt = SampleConfigWithTools & SampleConfigPromptMode;

/** Tools sample with messages */
export type SampleConfigToolsMessages = SampleConfigWithTools & SampleConfigMessagesMode;

/**
 * Configuration for a sampling request.
 * Supports two modes for message input:
 * - `prompt`: Simple prompt string, auto-tracked in tool-local conversation state
 * - `messages`: Explicit messages array, full control
 *
 * And three modes for output:
 * - Plain: Just text
 * - With schema: Parsed and validated structured output
 * - With tools: Tool calls returned for execution
 *
 * Note: `schema` and `tools` are mutually exclusive.
 */
export type McpToolSampleConfig =
  | SampleConfigPlainPrompt
  | SampleConfigPlainMessages
  | SampleConfigSchemaPrompt
  | SampleConfigSchemaMessages
  | SampleConfigToolsPrompt
  | SampleConfigToolsMessages;

// -----------------------------------------------------------------------------
// SAMPLE RESULT TYPES
// -----------------------------------------------------------------------------

/**
 * Base result of a sampling request.
 */
export interface SampleResultBase {
  /** The generated text */
  text: string;

  /** Model that generated the response */
  model?: string;

  /** Why generation stopped */
  stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;

  /**
   * Exchange for history accumulation.
   * Contains the request/response messages in MCP format.
   *
   * - Raw sampling: 2 messages [user, assistant]
   * - With tool calls: messages depend on response
   */
  exchange: SampleExchange<undefined>;
}

/**
 * Result when using structured output (schema).
 *
 * @template T - The type of the parsed output
 */
export interface SampleResultWithParsed<T> extends Omit<SampleResultBase, "exchange"> {
  /**
   * Parsed and validated output.
   * Null if parsing/validation failed (check parseError).
   */
  parsed: T | null;

  /**
   * Error from parsing or validation.
   * Present when parsed is null.
   */
  parseError?: {
    /** Error message */
    message: string;
    /** Raw text that failed to parse */
    rawText: string;
  };

  /**
   * Exchange for history accumulation.
   * Contains 3 messages for structured output: [request, toolUse, toolResult]
   */
  exchange: SampleExchange<T | null>;
}

/**
 * Result when using tool calling.
 */
export interface SampleResultWithToolCalls extends SampleResultBase {
  /**
   * Tool calls made by the model.
   * Present when stopReason is 'toolUse'.
   */
  toolCalls: SamplingToolCall[];
}

// -----------------------------------------------------------------------------
// RAW SAMPLE RESULT TYPES (for decoder/handler layers without exchange)
// -----------------------------------------------------------------------------

/**
 * Raw sample result without exchange.
 *
 * Used by decoder and handler layers that don't have access to the original
 * prompt text needed to construct exchanges. The exchange is added by the
 * runtime layer (for example bridge-runtime) which has the context.
 */
export interface WireSampleResultBase {
  /** The generated text */
  text: string;

  /** Model that generated the response */
  model?: string;

  /** Why generation stopped */
  stopReason?: "endTurn" | "maxTokens" | "toolUse" | string;
}

/**
 * Raw result with parsed data but no exchange.
 *
 * @template T - The type of the parsed output
 */
export interface WireSampleResultWithParsed<T> extends WireSampleResultBase {
  /**
   * Parsed and validated output.
   * Null if parsing/validation failed (check parseError).
   */
  parsed: T | null;

  /**
   * Error from parsing or validation.
   * Present when parsed is null.
   */
  parseError?: {
    /** Error message */
    message: string;
    /** Raw text that failed to parse */
    rawText: string;
  };
}

/**
 * Raw result with tool calls but no exchange.
 */
export interface WireSampleResultWithToolCalls extends WireSampleResultBase {
  /**
   * Tool calls made by the model.
   * Present when stopReason is 'toolUse'.
   */
  toolCalls: SamplingToolCall[];
}

/**
 * Union type for all raw sample results (without exchange).
 * Used by decoder and handler layers.
 */
export type WireSampleResult =
  | WireSampleResultBase
  | WireSampleResultWithParsed<unknown>
  | WireSampleResultWithToolCalls;

// =============================================================================
// SAMPLE HELPER CONFIG TYPES
// =============================================================================

/**
 * Base config for sample helpers with retry support.
 */
interface SampleHelperConfigBase extends SampleConfigBase {
  /**
   * Number of retry attempts if validation fails.
   * @default 2
   */
  retries?: number;
}

/**
 * Config for sampleTools helper.
 * Guarantees tool calls in the result or throws after retries.
 */
export interface SampleToolsConfig extends SampleHelperConfigBase {
  /** The prompt to send */
  prompt: string;
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[];
  /**
   * How the model should choose tools.
   * @default 'required'
   */
  toolChoice?: SamplingToolChoice;
}

/**
 * Config for sampleTools helper with explicit messages.
 */
export interface SampleToolsConfigMessages extends SampleHelperConfigBase {
  /** Explicit messages array (supports tool call/result messages) */
  messages: ExtendedMessage[];
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[];
  /**
   * How the model should choose tools.
   * @default 'required'
   */
  toolChoice?: SamplingToolChoice;
}

/**
 * Config for sampleSchema helper.
 * Guarantees parsed result or throws after retries.
 */
export interface SampleSchemaConfig<T> extends SampleHelperConfigBase {
  /** The prompt to send */
  prompt: string;
  /** Standard Schema for structured output */
  schema: StandardSchemaV1<unknown, T>;
}

/**
 * Config for sampleSchema helper with explicit messages.
 */
export interface SampleSchemaConfigMessages<T> extends SampleHelperConfigBase {
  /** Explicit messages array (supports tool call/result messages) */
  messages: ExtendedMessage[];
  /** Standard Schema for structured output */
  schema: StandardSchemaV1<unknown, T>;
}

/**
 * Guaranteed result from sampleTools - toolCalls is always present and non-empty.
 */
export interface SampleToolsResult extends SampleResultBase {
  /** Guaranteed non-empty tool calls */
  toolCalls: [SamplingToolCall, ...SamplingToolCall[]];
  stopReason: "toolUse";
}

/**
 * Guaranteed result from sampleSchema - parsed is always present and non-null.
 */
export interface SampleSchemaResult<T> extends Omit<SampleResultBase, "exchange"> {
  /** Guaranteed parsed value */
  parsed: T;
  /** Exchange with typed parsed data */
  exchange: SampleExchange<T>;
}

/**
 * Error thrown when sample helpers exhaust retries.
 */
export class SampleValidationError extends Error {
  constructor(
    public readonly helperName: "sampleTools" | "sampleSchema",
    public readonly attempts: number,
    public readonly lastResult:
      | SampleResultBase
      | SampleResultWithParsed<unknown>
      | SampleResultWithToolCalls,
    message: string,
  ) {
    super(message);
    this.name = "SampleValidationError";
  }
}

// =============================================================================
// LOGGING TYPES
// =============================================================================

/**
 * Log levels for MCP logging.
 */
export type LogLevel = "debug" | "info" | "warning" | "error";

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
export interface McpToolContext {
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
  readonly messages: readonly Message[];

  // ---------------------------------------------------------------------------
  // LLM backchannel
  // ---------------------------------------------------------------------------

  /**
   * Request an LLM completion from the client.
   *
   * Two modes for message input:
   * - `{ prompt }`: Auto-tracked in tool-local conversation state
   * - `{ messages }`: Explicit control, not tracked
   *
   * Three modes for output:
   * - Plain: Just text (default)
   * - With schema: Parsed and validated structured output
   * - With tools: Tool calls returned for execution
   *
   * Note: `schema` and `tools` are mutually exclusive.
   *
   * Maps to MCP: `sampling/createMessage`
   *
   * @example Auto-tracked (plain)
   * ```typescript
   * const result = yield* ctx.sample({ prompt: 'Summarize...' })
   * console.log(result.text)
   * ```
   *
   * @example Structured output
   * ```typescript
   * const MoveSchema = z.object({ cell: z.number().min(0).max(8) })
   * const result = yield* ctx.sample({
   *   prompt: 'Pick a cell',
   *   schema: MoveSchema,
   * })
   * if (result.parsed) {
   *   console.log('Cell:', result.parsed.cell)  // typed as number
   * }
   * ```
   *
   * @example Tool calling
   * ```typescript
   * const result = yield* ctx.sample({
   *   prompt: 'Make a move',
   *   tools: [{ name: 'make_move', inputSchema: z.object({ cell: z.number() }) }],
   *   toolChoice: 'required',
   * })
   * if (result.stopReason === 'toolUse') {
   *   const call = result.toolCalls[0]
   *   // Execute the tool...
   * }
   * ```
   */
  // Plain sample (no schema, no tools) - returns base result
  sample(config: SampleConfigPlainPrompt | SampleConfigPlainMessages): Operation<SampleResultBase>;
  // Schema sample - returns result with parsed field
  sample<T>(
    config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T>,
  ): Operation<SampleResultWithParsed<T>>;
  // Tools sample - returns result with toolCalls field
  sample(
    config: SampleConfigToolsPrompt | SampleConfigToolsMessages,
  ): Operation<SampleResultWithToolCalls>;
  // Catch-all for the implementation
  sample(
    config: McpToolSampleConfig,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;

  /**
   * Sample with guaranteed tool calls.
   *
   * Unlike raw `sample()`, this helper:
   * - Validates that the model returned tool calls
   * - Retries with a hint if validation fails
   * - Throws `SampleValidationError` after retries exhausted
   *
   * @param config - Sample configuration with tools
   * @returns Guaranteed result with non-empty toolCalls
   * @throws SampleValidationError if no tool calls after retries
   *
   * @example
   * ```typescript
   * const result = yield* ctx.sampleTools({
   *   prompt: 'Choose a strategy',
   *   tools: [
   *     { name: 'offensive', inputSchema: z.object({ reason: z.string() }) },
   *     { name: 'defensive', inputSchema: z.object({ threat: z.string() }) },
   *   ],
   *   retries: 3,  // optional, default 2
   * })
   * // result.toolCalls is guaranteed to be non-empty
   * const call = result.toolCalls[0]
   * ```
   */
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>;

  /**
   * Sample with guaranteed parsed schema.
   *
   * Unlike raw `sample()`, this helper:
   * - Validates that the model returned valid parsed output
   * - Retries with a hint if parsing fails
   * - Throws `SampleValidationError` after retries exhausted
   *
   * @param config - Sample configuration with schema
   * @returns Guaranteed result with parsed value (never null)
   * @throws SampleValidationError if parsing fails after retries
   *
   * @example
   * ```typescript
   * const MoveSchema = z.object({ cell: z.number().min(0).max(8) })
   * const result = yield* ctx.sampleSchema({
   *   prompt: 'Pick a cell (0-8)',
   *   schema: MoveSchema,
   *   retries: 3,  // optional, default 2
   * })
   * // result.parsed is guaranteed to be { cell: number }
   * console.log('Cell:', result.parsed.cell)
   * ```
   */
  sampleSchema<T>(
    config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>,
  ): Operation<SampleSchemaResult<T>>;

  // ---------------------------------------------------------------------------
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
 * @template TElicits - Map of elicitation keys to their Zod schemas
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
export interface McpToolContextWithElicits<TElicits extends ElicitsMap> {
  // ---------------------------------------------------------------------------
  // Current tool-local state - same as McpToolContext
  // ---------------------------------------------------------------------------

  /** Scope-owned cancellation signal for abort-aware external APIs. */
  readonly signal: AbortSignal;
  readonly messages: readonly Message[];

  // ---------------------------------------------------------------------------
  // LLM backchannel - same as McpToolContext
  // ---------------------------------------------------------------------------

  // Plain sample (no schema, no tools) - returns base result
  sample(config: SampleConfigPlainPrompt | SampleConfigPlainMessages): Operation<SampleResultBase>;
  // Schema sample - returns result with parsed field
  sample<T>(
    config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T>,
  ): Operation<SampleResultWithParsed<T>>;
  // Tools sample - returns result with toolCalls field
  sample(
    config: SampleConfigToolsPrompt | SampleConfigToolsMessages,
  ): Operation<SampleResultWithToolCalls>;
  // Catch-all for the implementation
  sample(
    config: McpToolSampleConfig,
  ): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>;

  /** Sample with guaranteed tool calls. See McpToolContext.sampleTools for details. */
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>;

  /** Sample with guaranteed parsed schema. See McpToolContext.sampleSchema for details. */
  sampleSchema<T>(
    config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>,
  ): Operation<SampleSchemaResult<T>>;

  // ---------------------------------------------------------------------------
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
    options: { message: string } & ExtractElicitContext<TElicits[K]>,
  ): Operation<
    ToolElicitResult<ExtractElicitContext<TElicits[K]>, ExtractElicitResponse<TElicits[K]>>
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

export type { ElicitExchange, SampleExchange } from "@sweatpants/agent-sdk";
