/**
 * MCP Tool Types
 *
 * Unified type definitions for MCP (Model Context Protocol) tools.
 * Provides a generator-based execution model with:
 * - LLM backchannel (sampling)
 * - User backchannel (elicitation)
 * - Sub-branching for structured concurrency
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
 * Tool calls are branches off the main LLM timeline. Each branch:
 * - Receives parent context (optionally uses it)
 * - Runs a server-driven generator
 * - Can spawn sub-branches that reduce back
 * - Returns a single result to the parent
 *
 * ```
 * Main Timeline
 *     |
 *     +-- tool_call --> branch --> reduces back
 *     |                   |
 *     |                   +-- sample (LLM backchannel)
 *     |                   +-- elicit (user backchannel)
 *     |                   +-- branch (sub-branch) --> reduces back
 *     |
 *     v continues
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  ElicitDefinition,
  ElicitsMap as BaseElicitsMap,
  ExtractElicitResponse,
  ExtractElicitContext,
  ExtractElicitResponseSchema,
  ExtractElicitContextSchema,
} from '@sweatpants/elicit-context'

// =============================================================================
// ELICITATION TYPES (shared)
// =============================================================================

/**
 * Result of an elicitation request.
 *
 * MCP elicitation has three response actions:
 * - `accept`: User submitted data (content contains the data)
 * - `decline`: User explicitly declined (clicked "No", "Reject", etc.)
 * - `cancel`: User dismissed without choosing (closed dialog, pressed Escape)
 */
export type ElicitResult<T> =
  | { action: 'accept'; content: T }
  | { action: 'decline' }
  | { action: 'cancel' }

/**
 * Configuration for an elicitation request (simple form).
 */
export interface ElicitConfig<T> {
  /** Message to display to the user */
  message: string

  /**
   * Zod schema for the expected response.
   *
   * Note: MCP elicitation only supports flat objects with primitive properties:
   * - string (with optional format: email, uri, date, date-time)
   * - number / integer (with optional min/max)
   * - boolean
   * - enum (string enums only)
   *
   * Nested objects and arrays are NOT supported.
   */
  schema: z.ZodType<T>
}

// =============================================================================
// ELICITATION SURFACE (finite, typed keys for bridgeable tools)
// =============================================================================

/**
 * Re-export ElicitDefinition from elicit-context package.
 */
export type { ElicitDefinition }

/**
 * A map of elicitation keys to their definitions (response + optional context schemas).
 *
 * Used with `.elicits({...})` to declare a finite elicitation surface.
 *
 * @example With context
 * ```typescript
 * const tool = createMcpTool('book_flight')
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
 * const tool = createMcpTool('confirm')
 *   .elicits({
 *     confirm: {
 *       response: z.object({ ok: z.boolean() }),
 *     },
 *   })
 * ```
 */
export type ElicitsMap = BaseElicitsMap

// Re-export type helpers from elicit-context package
export type {
  ExtractElicitResponse,
  ExtractElicitContext,
  ExtractElicitResponseSchema,
  ExtractElicitContextSchema,
}

/**
 * Structured elicitation ID for correlation and logging.
 * Simple key in API, structured id under the hood.
 */
export interface ElicitId {
  toolName: string
  key: string
  callId: string
  seq: number
}

/**
 * Request object passed to elicitation handlers.
 *
 * Context data (e.g., flights, seatMap) is transported via the `x-model-context`
 * extension in the schema and as a boundary-encoded section in the message.
 * Use `getElicitContext(req)` to extract it.
 *
 * @see getElicitContext from './model-context'
 */
export interface ElicitRequest<
  TKey extends string = string,
  TSchema extends z.ZodType = z.ZodType,
> {
  /** Structured id for correlation/logging */
  id: ElicitId

  /** The elicitation key (matches `.elicits()` declaration) */
  key: TKey

  /** Tool name */
  toolName: string

  /** Tool call id */
  callId: string

  /** Sequence number for this elicitation within the call */
  seq: number

  /**
   * Message to display to the user.
   *
   * May contain a boundary-encoded context section at the end.
   * Use `getElicitContext(req)` to extract context and get clean message.
   */
  message: string

  /**
   * Schema in both forms.
   *
   * The `json` schema may contain `x-model-context` extension with context data.
   * Use `getElicitContext(req)` to extract it.
   */
  schema: {
    zod: TSchema
    json: Record<string, unknown>
  }

  /** Original tool params (for context) */
  params?: unknown

  /** Handoff data from before() phase (for richer UI) */
  handoff?: unknown
}

// =============================================================================
// MESSAGE TYPES
// =============================================================================

/**
 * Role in a conversation.
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * A message in a conversation.
 */
export interface Message {
  role: MessageRole
  content: string
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
  hints?: Array<{ name: string }>

  /** How important is minimizing cost? (0-1, higher = prefer cheaper) */
  costPriority?: number

  /** How important is low latency? (0-1, higher = prefer faster) */
  speedPriority?: number

  /** How important are advanced capabilities? (0-1, higher = prefer smarter) */
  intelligencePriority?: number
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
  name: string

  /** Description for the LLM */
  description?: string

  /**
   * Input schema as Zod type or raw JSON Schema.
   * Zod schemas will be converted to JSON Schema internally.
   */
  inputSchema: z.ZodType | Record<string, unknown>
}

/**
 * A tool call returned by the model during sampling.
 */
export interface SamplingToolCall {
  /** Unique ID for this tool call (for correlation with results) */
  id: string

  /** Name of the tool being called */
  name: string

  /** Arguments to the tool (parsed from model output) */
  arguments: Record<string, unknown>
}

/**
 * Tool choice configuration for sampling.
 */
export type SamplingToolChoice = 'auto' | 'required' | 'none'

// -----------------------------------------------------------------------------
// SAMPLE CONFIG BASE
// -----------------------------------------------------------------------------

/**
 * Base sample configuration (shared fields).
 */
interface SampleConfigBase {
  /** Optional system prompt override */
  systemPrompt?: string

  /** Maximum tokens to generate */
  maxTokens?: number

  /** Model preferences for the client */
  modelPreferences?: ModelPreferences
}

// -----------------------------------------------------------------------------
// SAMPLE CONFIG VARIANTS (mutually exclusive)
// -----------------------------------------------------------------------------

/**
 * Plain sample config - no schema or tools.
 */
interface SampleConfigPlain extends SampleConfigBase {
  schema?: never
  tools?: never
  toolChoice?: never
}

/**
 * Sample config with structured output schema.
 * The response will be parsed and validated against the schema.
 *
 * @template T - The type of the parsed output
 */
interface SampleConfigWithSchema<T = unknown> extends SampleConfigBase {
  /**
   * Zod schema for structured output.
   * The model's response will be parsed and validated against this schema.
   * Uses provider's native structured output when available.
   */
  schema: z.ZodType<T>
  tools?: never
  toolChoice?: never
}

/**
 * Sample config with tool definitions.
 * Enables the model to call tools, returning tool calls in the result.
 */
interface SampleConfigWithTools extends SampleConfigBase {
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[]

  /**
   * How the model should choose tools:
   * - 'auto': Model decides whether to call a tool (default)
   * - 'required': Model must call at least one tool
   * - 'none': Tools are provided for context but model cannot call them
   */
  toolChoice?: SamplingToolChoice
  schema?: never
}

// -----------------------------------------------------------------------------
// MESSAGE MODE VARIANTS
// -----------------------------------------------------------------------------

/**
 * Sample with auto-tracked prompt (appends to branch context).
 */
interface SampleConfigPromptMode {
  /** The prompt to send (auto-tracked in branch context) */
  prompt: string
  messages?: never
}

/**
 * Sample with explicit messages (full control).
 */
interface SampleConfigMessagesMode {
  /** Explicit messages array (not auto-tracked) */
  messages: Message[]
  prompt?: never
}

// -----------------------------------------------------------------------------
// COMBINED SAMPLE CONFIG TYPES
// -----------------------------------------------------------------------------

/** Plain sample with prompt */
export type SampleConfigPlainPrompt = SampleConfigPlain & SampleConfigPromptMode

/** Plain sample with messages */
export type SampleConfigPlainMessages = SampleConfigPlain & SampleConfigMessagesMode

/** Schema sample with prompt */
export type SampleConfigSchemaPrompt<T = unknown> = SampleConfigWithSchema<T> & SampleConfigPromptMode

/** Schema sample with messages */
export type SampleConfigSchemaMessages<T = unknown> = SampleConfigWithSchema<T> & SampleConfigMessagesMode

/** Tools sample with prompt */
export type SampleConfigToolsPrompt = SampleConfigWithTools & SampleConfigPromptMode

/** Tools sample with messages */
export type SampleConfigToolsMessages = SampleConfigWithTools & SampleConfigMessagesMode

/**
 * Legacy type for backwards compatibility.
 * @deprecated Use specific sample config types for type safety
 */
export type SampleConfigPrompt = SampleConfigPlainPrompt
export type SampleConfigMessages = SampleConfigPlainMessages

/**
 * Configuration for a sampling request.
 * Supports two modes for message input:
 * - `prompt`: Simple prompt string, auto-tracked in branch context
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
  | SampleConfigToolsMessages

// -----------------------------------------------------------------------------
// SAMPLE RESULT TYPES
// -----------------------------------------------------------------------------

/**
 * Base result of a sampling request.
 */
export interface SampleResultBase {
  /** The generated text */
  text: string

  /** Model that generated the response */
  model?: string

  /** Why generation stopped */
  stopReason?: 'endTurn' | 'maxTokens' | 'toolUse' | string
}

/**
 * Result when using structured output (schema).
 *
 * @template T - The type of the parsed output
 */
export interface SampleResultWithParsed<T> extends SampleResultBase {
  /**
   * Parsed and validated output.
   * Null if parsing/validation failed (check parseError).
   */
  parsed: T | null

  /**
   * Error from parsing or validation.
   * Present when parsed is null.
   */
  parseError?: {
    /** Error message */
    message: string
    /** Raw text that failed to parse */
    rawText: string
  }
}

/**
 * Result when using tool calling.
 */
export interface SampleResultWithToolCalls extends SampleResultBase {
  /**
   * Tool calls made by the model.
   * Present when stopReason is 'toolUse'.
   */
  toolCalls: SamplingToolCall[]
}

/**
 * Legacy type alias for backwards compatibility.
 * @deprecated Use SampleResultBase for plain results
 */
export type SampleResult = SampleResultBase

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
  retries?: number
}

/**
 * Config for sampleTools helper.
 * Guarantees tool calls in the result or throws after retries.
 */
export interface SampleToolsConfig extends SampleHelperConfigBase {
  /** The prompt to send */
  prompt: string
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[]
  /**
   * How the model should choose tools.
   * @default 'required'
   */
  toolChoice?: SamplingToolChoice
}

/**
 * Config for sampleTools helper with explicit messages.
 */
export interface SampleToolsConfigMessages extends SampleHelperConfigBase {
  /** Explicit messages array */
  messages: Message[]
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[]
  /**
   * How the model should choose tools.
   * @default 'required'
   */
  toolChoice?: SamplingToolChoice
}

/**
 * Config for sampleSchema helper.
 * Guarantees parsed result or throws after retries.
 */
export interface SampleSchemaConfig<T> extends SampleHelperConfigBase {
  /** The prompt to send */
  prompt: string
  /** Zod schema for structured output */
  schema: z.ZodType<T>
}

/**
 * Config for sampleSchema helper with explicit messages.
 */
export interface SampleSchemaConfigMessages<T> extends SampleHelperConfigBase {
  /** Explicit messages array */
  messages: Message[]
  /** Zod schema for structured output */
  schema: z.ZodType<T>
}

/**
 * Guaranteed result from sampleTools - toolCalls is always present and non-empty.
 */
export interface SampleToolsResult extends SampleResultBase {
  /** Guaranteed non-empty tool calls */
  toolCalls: [SamplingToolCall, ...SamplingToolCall[]]
  stopReason: 'toolUse'
}

/**
 * Guaranteed result from sampleSchema - parsed is always present and non-null.
 */
export interface SampleSchemaResult<T> extends SampleResultBase {
  /** Guaranteed parsed value */
  parsed: T
}

/**
 * Error thrown when sample helpers exhaust retries.
 */
export class SampleValidationError extends Error {
  constructor(
    public readonly helperName: 'sampleTools' | 'sampleSchema',
    public readonly attempts: number,
    public readonly lastResult: SampleResultBase,
    message: string
  ) {
    super(message)
    this.name = 'SampleValidationError'
  }
}

// =============================================================================
// LOGGING TYPES
// =============================================================================

/**
 * Log levels for MCP logging.
 */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

// =============================================================================
// BRANCH OPTIONS
// =============================================================================

/**
 * Options for creating a sub-branch.
 */
export interface McpToolBranchOptions {
  // ---------------------------------------------------------------------------
  // Context inheritance
  // ---------------------------------------------------------------------------

  /**
   * Whether to inherit parent messages.
   * @default true
   */
  inheritMessages?: boolean

  /**
   * Whether to inherit parent system prompt.
   * @default true
   */
  inheritSystemPrompt?: boolean

  /**
   * Override/supplement messages for this branch.
   * If inheritMessages is true, these are appended.
   * If inheritMessages is false, these replace.
   */
  messages?: Message[]

  /**
   * Override system prompt for this branch.
   */
  systemPrompt?: string

  // ---------------------------------------------------------------------------
  // Limits
  // ---------------------------------------------------------------------------

  /**
   * Maximum branch depth from this point.
   * Prevents infinite recursion.
   */
  maxDepth?: number

  /**
   * Maximum total tokens for this branch and its children.
   */
  maxTokens?: number

  /**
   * Timeout in milliseconds for this branch.
   */
  timeout?: number
}

/**
 * Limits configuration for tool execution.
 */
export interface McpToolLimits {
  /** Maximum branch depth */
  maxDepth?: number

  /** Maximum total tokens across all branches */
  maxTokens?: number

  /** Timeout in milliseconds */
  timeout?: number
}

// =============================================================================
// MCP TOOL CONTEXT
// =============================================================================

/**
 * Context available in MCP tool execution.
 *
 * Provides primitives for:
 * - Reading parent context
 * - Managing current branch conversation
 * - LLM backchannel (sample)
 * - User input backchannel (elicit)
 * - Spawning sub-branches
 *
 * @example
 * ```typescript
 * *client(handoff, ctx: McpToolContext) {
 *   // Auto-tracked conversation
 *   const analysis = yield* ctx.sample({ prompt: 'Analyze...' })
 *
 *   // Sub-branch for focused task
 *   const detail = yield* ctx.branch(function* (subCtx) {
 *     return yield* subCtx.sample({ prompt: 'Detail...' })
 *   }, { inheritMessages: false })
 *
 *   // User confirmation
 *   const choice = yield* ctx.elicit({
 *     message: 'Confirm?',
 *     schema: z.object({ ok: z.boolean() })
 *   })
 *
 *   return { analysis, detail, confirmed: choice.action === 'accept' }
 * }
 * ```
 */
export interface McpToolContext {
  // ---------------------------------------------------------------------------
  // Parent context (read-only)
  // ---------------------------------------------------------------------------

  /**
   * Messages from the parent context.
   * This is the conversation history up to when this branch was created.
   * Read-only - modifications don't affect parent.
   */
  readonly parentMessages: readonly Message[]

  /**
   * System prompt from the parent context.
   * Undefined if no system prompt was set.
   */
  readonly parentSystemPrompt: string | undefined

  // ---------------------------------------------------------------------------
  // Current branch state
  // ---------------------------------------------------------------------------

  /**
   * Messages in this branch's conversation.
   * Auto-updated when using `sample({ prompt })` form.
   * Read-only view - use sample/elicit to modify.
   */
  readonly messages: readonly Message[]

  /**
   * Current depth in the branch tree.
   * Root branch is depth 0.
   */
  readonly depth: number

  // ---------------------------------------------------------------------------
  // LLM backchannel
  // ---------------------------------------------------------------------------

  /**
   * Request an LLM completion from the client.
   *
   * Two modes for message input:
   * - `{ prompt }`: Auto-tracked in branch context
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
  sample(config: SampleConfigPlainPrompt | SampleConfigPlainMessages): Operation<SampleResultBase>
  // Schema sample - returns result with parsed field
  sample<T>(config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T>): Operation<SampleResultWithParsed<T>>
  // Tools sample - returns result with toolCalls field
  sample(config: SampleConfigToolsPrompt | SampleConfigToolsMessages): Operation<SampleResultWithToolCalls>
  // Catch-all for the implementation
  sample(config: McpToolSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>

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
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>

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
  sampleSchema<T>(config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>>

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
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<T>>

  // ---------------------------------------------------------------------------
  // Sub-branches
  // ---------------------------------------------------------------------------

  /**
   * Spawn a sub-branch for structured concurrency.
   *
   * Sub-branches:
   * - Run server-side (not a separate MCP call)
   * - Can sample/elicit/branch themselves
   * - Reduce back to a single value
   *
   * For concurrent branches, use Effection's `all()`:
   * ```typescript
   * const [a, b] = yield* all([
   *   ctx.branch(branchA),
   *   ctx.branch(branchB),
   * ])
   * ```
   *
   * @example Sequential branches
   * ```typescript
   * const first = yield* ctx.branch(function* (subCtx) {
   *   return yield* subCtx.sample({ prompt: 'First task...' })
   * })
   *
   * const second = yield* ctx.branch(function* (subCtx) {
   *   return yield* subCtx.sample({ prompt: `Based on ${first}...` })
   * })
   * ```
   *
   * @example With options
   * ```typescript
   * const isolated = yield* ctx.branch(function* (subCtx) {
   *   // Fresh context, no parent messages
   *   return yield* subCtx.sample({ prompt: 'Independent task...' })
   * }, {
   *   inheritMessages: false,
   *   maxDepth: 2,
   *   timeout: 5000
   * })
   * ```
   */
  branch<T>(
    fn: (ctx: McpToolContext) => Operation<T>,
    options?: McpToolBranchOptions
  ): Operation<T>

  // ---------------------------------------------------------------------------
  // Logging
  // ---------------------------------------------------------------------------

  /**
   * Send a log message to the client.
   *
   * Maps to MCP: `notifications/message`
   */
  log(level: LogLevel, message: string): Operation<void>

  /**
   * Send a progress notification to the client.
   *
   * Maps to MCP: `notifications/progress`
   */
  notify(message: string, progress?: number): Operation<void>
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
 * const tool = createMcpTool('book_flight')
 *   .elicits({
 *     pickFlight: z.object({ flightId: z.string() }),
 *     confirm: z.object({ ok: z.boolean() }),
 *   })
 *   .handoff({
 *     *client(handoff, ctx) {
 *       // ctx.elicit is keyed and type-safe
 *       const picked = yield* ctx.elicit('pickFlight', { message: 'Pick a flight' })
 *       const ok = yield* ctx.elicit('confirm', { message: 'Confirm?' })
 *       return { picked, ok }
 *     }
 *   })
 * ```
 */
export interface McpToolContextWithElicits<TElicits extends ElicitsMap> {
  // ---------------------------------------------------------------------------
  // Parent context (read-only) - same as McpToolContext
  // ---------------------------------------------------------------------------

  readonly parentMessages: readonly Message[]
  readonly parentSystemPrompt: string | undefined

  // ---------------------------------------------------------------------------
  // Current branch state - same as McpToolContext
  // ---------------------------------------------------------------------------

  readonly messages: readonly Message[]
  readonly depth: number

  // ---------------------------------------------------------------------------
  // LLM backchannel - same as McpToolContext
  // ---------------------------------------------------------------------------

  // Plain sample (no schema, no tools) - returns base result
  sample(config: SampleConfigPlainPrompt | SampleConfigPlainMessages): Operation<SampleResultBase>
  // Schema sample - returns result with parsed field
  sample<T>(config: SampleConfigSchemaPrompt<T> | SampleConfigSchemaMessages<T>): Operation<SampleResultWithParsed<T>>
  // Tools sample - returns result with toolCalls field
  sample(config: SampleConfigToolsPrompt | SampleConfigToolsMessages): Operation<SampleResultWithToolCalls>
  // Catch-all for the implementation
  sample(config: McpToolSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>

  /** Sample with guaranteed tool calls. See McpToolContext.sampleTools for details. */
  sampleTools(config: SampleToolsConfig | SampleToolsConfigMessages): Operation<SampleToolsResult>

  /** Sample with guaranteed parsed schema. See McpToolContext.sampleSchema for details. */
  sampleSchema<T>(config: SampleSchemaConfig<T> | SampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>>

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
    options: { message: string } & ExtractElicitContext<TElicits[K]>
  ): Operation<ElicitResult<ExtractElicitResponse<TElicits[K]>>>

  // ---------------------------------------------------------------------------
  // Sub-branches - inherit keyed elicitation
  // ---------------------------------------------------------------------------

  /**
   * Spawn a sub-branch for structured concurrency.
   * Sub-branches inherit the keyed elicitation context.
   */
  branch<T>(
    fn: (ctx: McpToolContextWithElicits<TElicits>) => Operation<T>,
    options?: McpToolBranchOptions
  ): Operation<T>

  // ---------------------------------------------------------------------------
  // Logging - same as McpToolContext
  // ---------------------------------------------------------------------------

  log(level: LogLevel, message: string): Operation<void>
  notify(message: string, progress?: number): Operation<void>
}

// =============================================================================
// SERVER CONTEXT
// =============================================================================

/**
 * Server context for before() and after() phases.
 */
export interface McpToolServerContext {
  /** Unique identifier for this tool call */
  callId: string

  /** Abort signal for cancellation */
  signal: AbortSignal
}

// =============================================================================
// HANDOFF CONFIGURATION
// =============================================================================

/**
 * Configuration for a tool with handoff pattern.
 *
 * Type flow:
 * ```
 * TParams --> before(params, ctx) --> THandoff
 *                                        |
 *         +------------------------------+
 *         v                              v
 * client(handoff, ctx) --> TClient
 *         |                              |
 *         +--------> after(handoff, client, ctx, params) --> TResult
 * ```
 *
 * @template TParams - Tool parameters from LLM
 * @template THandoff - Data from before() to client() and after()
 * @template TClient - Data from client() to after()
 * @template TResult - Final result returned to LLM
 */
export interface McpToolHandoffConfig<TParams, THandoff, TClient, TResult> {
  /**
   * Phase 1: Server-side setup (runs ONCE).
   *
   * Put expensive computations, database lookups, random selections,
   * or any non-idempotent code here. The return value is:
   * 1. Passed to client() as handoff data
   * 2. Cached and passed to after() (NOT re-computed)
   */
  before: (params: TParams, ctx: McpToolServerContext) => Operation<THandoff>

  /**
   * Client phase: Branch-based multi-turn interaction.
   *
   * This is where you use ctx.sample(), ctx.elicit(), and ctx.branch()
   * for complex multi-turn conversations with the LLM and user.
   */
  client: (handoff: THandoff, ctx: McpToolContext) => Operation<TClient>

  /**
   * Phase 2: Server-side finalization (runs ONCE after client).
   *
   * Receives:
   * - handoff: Cached data from before() (NOT re-computed)
   * - client: Response from client()
   *
   * Returns the final result that goes to the LLM.
   */
  after: (
    handoff: THandoff,
    client: TClient,
    ctx: McpToolServerContext,
    params: TParams
  ) => Operation<TResult>
}

/**
 * Configuration for a tool with handoff and keyed elicitation.
 *
 * Same as McpToolHandoffConfig but the client phase receives
 * McpToolContextWithElicits for type-safe, keyed elicitation.
 *
 * @template TParams - Tool parameters from LLM
 * @template THandoff - Data from before() to client() and after()
 * @template TClient - Data from client() to after()
 * @template TResult - Final result returned to LLM
 * @template TElicits - Map of elicitation keys to their Zod schemas
 */
export interface McpToolHandoffConfigWithElicits<
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
> {
  before: (params: TParams, ctx: McpToolServerContext) => Operation<THandoff>

  client: (
    handoff: THandoff,
    ctx: McpToolContextWithElicits<TElicits>
  ) => Operation<TClient>

  after: (
    handoff: THandoff,
    client: TClient,
    ctx: McpToolServerContext,
    params: TParams
  ) => Operation<TResult>
}

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error thrown when MCP client doesn't support a required capability.
 */
export class McpCapabilityError extends Error {
  constructor(
    public readonly capability: 'elicitation' | 'sampling',
    message: string
  ) {
    super(message)
    this.name = 'McpCapabilityError'
  }
}

/**
 * Error thrown when user declines an elicitation.
 */
export class ElicitationDeclinedError extends Error {
  constructor(message = 'User declined the elicitation request') {
    super(message)
    this.name = 'ElicitationDeclinedError'
  }
}

/**
 * Error thrown when user cancels an elicitation.
 */
export class ElicitationCancelledError extends Error {
  constructor(message = 'User cancelled the elicitation request') {
    super(message)
    this.name = 'ElicitationCancelledError'
  }
}

/**
 * Error thrown when branch depth limit is exceeded.
 */
export class McpToolDepthError extends Error {
  constructor(
    public readonly depth: number,
    public readonly maxDepth: number
  ) {
    super(`Branch depth ${depth} exceeds maximum ${maxDepth}`)
    this.name = 'McpToolDepthError'
  }
}

/**
 * Error thrown when branch token budget is exceeded.
 */
export class McpToolTokenError extends Error {
  constructor(
    public readonly used: number,
    public readonly budget: number
  ) {
    super(`Branch used ${used} tokens, exceeding budget of ${budget}`)
    this.name = 'McpToolTokenError'
  }
}

/**
 * Error thrown when branch times out.
 */
export class McpToolTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Branch timed out after ${timeoutMs}ms`)
    this.name = 'McpToolTimeoutError'
  }
}

/**
 * Error thrown on MCP disconnect.
 */
export class McpDisconnectError extends Error {
  constructor(message = 'MCP client disconnected') {
    super(message)
    this.name = 'McpDisconnectError'
  }
}
