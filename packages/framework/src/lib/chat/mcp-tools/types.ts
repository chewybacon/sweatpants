/**
 * MCP Tool Types
 *
 * Types for authoring MCP (Model Context Protocol) tools using our
 * generator-based approach. Maps MCP's bidirectional primitives to
 * ergonomic yield* operations.
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
 * ## Multi-Turn Flow
 *
 * ```
 * MCP Client                              MCP Server (your tool)
 *     |                                           |
 *     |------ tools/call (my_tool) ------------->|
 *     |                                           |  before() runs
 *     |<----- elicitation/create ----------------|  yield* ctx.elicit()
 *     |------ elicitation response ------------->|  generator resumes
 *     |<----- sampling/createMessage ------------|  yield* ctx.sample()
 *     |------ sampling response ---------------->|  generator resumes
 *     |                                           |  after() runs
 *     |<----- tools/call result -----------------|
 * ```
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type { z } from 'zod'

// =============================================================================
// ELICITATION TYPES
// =============================================================================

// Import from the canonical location
import type {
  ElicitExchange as _ElicitExchange,
  ElicitResult as _ElicitResult,
  RawElicitResult as _RawElicitResult,
  AssistantToolCallMessage as _AssistantToolCallMessage,
  ToolResultMessage as _ToolResultMessage,
  ToolCall as _ToolCall,
  ExtendedMessage as _ExtendedMessage,
} from './mcp-tool-types.ts'

// Re-export for consumers
export type ElicitExchange<T> = _ElicitExchange<T>
export type ElicitResult<TContext, TResponse> = _ElicitResult<TContext, TResponse>
export type RawElicitResult<TResponse> = _RawElicitResult<TResponse>
export type AssistantToolCallMessage = _AssistantToolCallMessage
export type ToolResultMessage = _ToolResultMessage
export type ToolCall = _ToolCall
export type ExtendedMessage = _ExtendedMessage

/**
 * Configuration for an elicitation request.
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

/**
 * Configuration for a sampling (LLM completion) request.
 */
export interface SampleConfig<T = string> {
  /** The prompt text to send to the LLM */
  prompt: string

  /** Optional system prompt */
  systemPrompt?: string

  /**
   * Optional Zod schema for structured output.
   * If provided, the response will be parsed and validated.
   */
  schema?: z.ZodType<T>

  /** Maximum tokens to generate */
  maxTokens?: number

  /** Model preferences for the client */
  modelPreferences?: ModelPreferences
}

// =============================================================================
// LOGGING TYPES
// =============================================================================

/**
 * Log levels for MCP logging.
 */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

// =============================================================================
// MCP CLIENT CONTEXT
// =============================================================================

/**
 * Context available in the `*client()` generator of MCP tools.
 *
 * Provides primitives for bidirectional communication with the MCP client
 * during tool execution. Each method maps to an MCP protocol message.
 */
export interface MCPClientContext {
  /**
   * Request structured input from the user via MCP elicitation.
   *
   * Maps to: `elicitation/create`
   *
   * The generator suspends until the user responds (accept, decline, or cancel).
   *
   * @example
   * ```typescript
   * const result = yield* ctx.elicit({
   *   message: 'Pick a flight:',
   *   schema: z.object({ flightId: z.string() })
   * })
   *
   * if (result.action === 'accept') {
   *   console.log('User picked:', result.content.flightId)
   * }
   * ```
   */
  elicit<T>(config: ElicitConfig<T>): Operation<ElicitResult<unknown, T>>

  /**
   * Request an LLM completion from the client via MCP sampling.
   *
   * Maps to: `sampling/createMessage`
   *
   * The generator suspends until the LLM response is received.
   * If a schema is provided, the response is parsed and validated.
   *
   * @example
   * ```typescript
   * // Unstructured response
   * const summary = yield* ctx.sample({
   *   prompt: 'Summarize this booking',
   *   maxTokens: 100
   * })
   *
   * // Structured response
   * const analysis = yield* ctx.sample({
   *   prompt: 'Analyze sentiment',
   *   schema: z.object({
   *     sentiment: z.enum(['positive', 'negative', 'neutral']),
   *     confidence: z.number()
   *   })
   * })
   * ```
   */
  sample<T = string>(config: SampleConfig<T>): Operation<T>

  /**
   * Send a log message to the client.
   *
   * Maps to: `notifications/message` (logging)
   *
   * @example
   * ```typescript
   * yield* ctx.log('info', 'Processing started')
   * yield* ctx.log('error', 'Failed to connect')
   * ```
   */
  log(level: LogLevel, message: string): Operation<void>

  /**
   * Send a progress notification to the client.
   *
   * Maps to: `notifications/progress`
   *
   * @example
   * ```typescript
   * yield* ctx.notify('Searching flights...')
   * yield* ctx.notify('Found 5 results', 0.5)  // 50% progress
   * ```
   */
  notify(message: string, progress?: number): Operation<void>
}

// =============================================================================
// SERVER CONTEXT
// =============================================================================

/**
 * Context available in `before()` and `after()` phases of MCP tools.
 *
 * This is the server-side context - no MCP client communication here.
 * Use this for database access, external APIs, etc.
 */
export interface MCPServerContext {
  /** Unique identifier for this tool call */
  callId: string

  /** Abort signal for cancellation */
  signal: AbortSignal
}

// =============================================================================
// HANDOFF CONFIGURATION
// =============================================================================

/**
 * Configuration for an MCP tool with handoff pattern.
 *
 * Type flow:
 * ```
 * TParams ──► before(params, ctx) → THandoff
 *                                      │
 *        ┌─────────────────────────────┤
 *        ▼                             ▼
 * client(handoff, ctx) → TClient
 *        │                             │
 *        └───────► after(handoff, client, ctx, params) → TResult
 * ```
 *
 * @template TParams - Tool parameters (from LLM)
 * @template THandoff - Data from before() to client() and after()
 * @template TClient - Data from client() to after()
 * @template TResult - Final result returned to LLM
 */
export interface MCPHandoffConfig<TParams, THandoff, TClient, TResult> {
  /**
   * Phase 1: Server-side setup (runs ONCE).
   *
   * Put expensive computations, database lookups, random selections,
   * or any non-idempotent code here. The return value is:
   * 1. Passed to client() as handoff data
   * 2. Cached and passed to after() (NOT re-computed)
   */
  before: (params: TParams, ctx: MCPServerContext) => Operation<THandoff>

  /**
   * Client phase: Multi-turn MCP interaction.
   *
   * This is where you use ctx.elicit() and ctx.sample() for
   * bidirectional communication with the MCP client.
   *
   * Can yield* multiple times for multi-turn conversations.
   */
  client: (handoff: THandoff, ctx: MCPClientContext) => Operation<TClient>

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
    ctx: MCPServerContext,
    params: TParams
  ) => Operation<TResult>
}

// =============================================================================
// MCP TOOL DEFINITION
// =============================================================================

/**
 * A fully configured MCP tool.
 *
 * @template TName - Tool name (literal string type)
 * @template TParams - Tool parameters
 * @template THandoff - Handoff data type (undefined if no handoff)
 * @template TClient - Client output type
 * @template TResult - Final result type
 */
export interface MCPToolDef<
  TName extends string = string,
  TParams = unknown,
  THandoff = unknown,
  TClient = unknown,
  TResult = unknown,
> {
  /** Tool name (used by LLM to invoke) */
  name: TName

  /** Description shown to LLM */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /**
   * Required MCP client capabilities.
   * Tool won't be listed if client doesn't have these.
   */
  requires?: {
    elicitation?: boolean
    sampling?: boolean
  }

  /**
   * Handoff configuration (for tools with multi-turn interaction).
   */
  handoffConfig?: MCPHandoffConfig<TParams, THandoff, TClient, TResult>

  /**
   * Simple execute function (for tools without handoff).
   */
  execute?: (params: TParams, ctx: MCPClientContext) => Operation<TResult>
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Any MCP tool (for arrays/registries).
 */
export type AnyMCPTool = MCPToolDef<string, any, any, any, any>

/**
 * Extract params type from an MCP tool.
 */
export type InferMCPToolParams<T> = T extends MCPToolDef<any, infer P, any, any, any>
  ? P
  : never

/**
 * Extract result type from an MCP tool.
 */
export type InferMCPToolResult<T> = T extends MCPToolDef<any, any, any, any, infer R>
  ? R
  : never

/**
 * Extract handoff type from an MCP tool.
 */
export type InferMCPToolHandoff<T> = T extends MCPToolDef<any, any, infer H, any, any>
  ? H
  : never

/**
 * Extract client output type from an MCP tool.
 */
export type InferMCPToolClient<T> = T extends MCPToolDef<any, any, any, infer C, any>
  ? C
  : never

// =============================================================================
// ERRORS
// =============================================================================

/**
 * Error thrown when MCP client doesn't support a required capability.
 */
export class MCPCapabilityError extends Error {
  constructor(
    public readonly capability: 'elicitation' | 'sampling',
    message: string
  ) {
    super(message)
    this.name = 'MCPCapabilityError'
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
 * Error thrown on MCP timeout.
 */
export class MCPTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`MCP operation '${operation}' timed out after ${timeoutMs}ms`)
    this.name = 'MCPTimeoutError'
  }
}

/**
 * Error thrown on MCP disconnect.
 */
export class MCPDisconnectError extends Error {
  constructor(message = 'MCP client disconnected') {
    super(message)
    this.name = 'MCPDisconnectError'
  }
}
