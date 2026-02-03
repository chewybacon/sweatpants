/**
 * Unified Tool Types
 *
 * Type definitions for the unified tool system that combines:
 * - MCP tools (sampling, elicitation, branching)
 * - Isomorphic tools (server↔client handoff)
 * - Core tool adapters
 *
 * @packageDocumentation
 */
import type { Operation } from 'effection'
import type { z } from 'zod'

// =============================================================================
// ELICITATION TYPES
// =============================================================================

/**
 * Map of elicitation keys to their response schemas.
 * Tools define this upfront for type-safe `ctx.elicit()` calls.
 */
export type ElicitsMap = Record<string, z.ZodType>

/**
 * Infer the response type for a given elicit key.
 */
export type InferElicitResponse<
  TElicits extends ElicitsMap,
  K extends keyof TElicits,
> = z.infer<TElicits[K]>

/**
 * Result of an elicitation request.
 */
export type ElicitResult<T> =
  | { action: 'accept'; content: T }
  | { action: 'decline' }
  | { action: 'cancel' }

/**
 * Data passed to elicitation handler (UI component).
 */
export interface ElicitData {
  message: string
  [key: string]: unknown
}

// =============================================================================
// SAMPLING TYPES
// =============================================================================

/**
 * Message in a conversation.
 */
export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/**
 * Tool call from LLM.
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Configuration for a sample request (prompt-based).
 */
export interface SampleConfigPrompt {
  prompt: string
  systemPrompt?: string
  maxTokens?: number
}

/**
 * Configuration for a sample request (messages-based).
 */
export interface SampleConfigMessages {
  messages: Message[]
  systemPrompt?: string
  maxTokens?: number
}

/**
 * Configuration for a sample request.
 */
export type SampleConfig = SampleConfigPrompt | SampleConfigMessages

/**
 * Base result from sampling.
 */
export interface SampleResult {
  text: string
  model?: string
  stopReason?: string
}

/**
 * Configuration for structured output sampling.
 */
export interface SampleSchemaConfig<T> {
  prompt: string
  schema: z.ZodType<T>
  systemPrompt?: string
  maxTokens?: number
  retries?: number
}

/**
 * Result from schema-based sampling.
 */
export interface SampleSchemaResult<T> {
  text: string
  parsed: T
  model?: string
  stopReason?: string
}

/**
 * Tool definition for tool-use sampling.
 */
export interface SamplingToolDefinition {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

/**
 * Configuration for tool-use sampling.
 */
export interface SampleToolsConfig {
  prompt: string
  tools: SamplingToolDefinition[]
  toolChoice?: 'auto' | 'required' | { name: string }
  systemPrompt?: string
  maxTokens?: number
  retries?: number
}

/**
 * Result from tool-use sampling.
 */
export interface SampleToolsResult {
  text: string
  toolCalls: Array<{
    id: string
    name: string
    arguments: Record<string, unknown>
  }>
  model?: string
  stopReason?: string
}

// =============================================================================
// LOG TYPES
// =============================================================================

/**
 * Log level for tool messages.
 */
export type LogLevel = 'debug' | 'info' | 'warning' | 'error'

// =============================================================================
// TOOL CONTEXT TYPES
// =============================================================================

/**
 * Limits for tool execution.
 */
export interface ToolLimits {
  maxDepth?: number
  maxTokens?: number
  timeout?: number
}

/**
 * Base tool context (available in all handlers).
 */
export interface ToolContextBase {
  /** Log a message */
  log(level: LogLevel, message: string): void

  /** Report progress to the user */
  notify(message: string, progress?: number): Operation<void>
}

/**
 * Server-side tool context (for before/after handlers).
 */
export interface ServerToolContext extends ToolContextBase {
  // Server-only capabilities can be added here
}

/**
 * Tool context with sampling capabilities.
 */
export interface ToolContextWithSampling extends ToolContextBase {
  /** Sample from the LLM */
  sample(config: SampleConfig): Operation<SampleResult>

  /** Sample with guaranteed structured output */
  sampleSchema<T>(config: SampleSchemaConfig<T>): Operation<SampleSchemaResult<T>>

  /** Sample with guaranteed tool calls */
  sampleTools(config: SampleToolsConfig): Operation<SampleToolsResult>
}

/**
 * Tool context with keyed elicitation.
 */
export interface ToolContextWithElicits<TElicits extends ElicitsMap>
  extends ToolContextWithSampling {
  /**
   * Request user input via elicitation.
   *
   * @param key - The elicitation key (must be defined in `.elicit()`)
   * @param data - Data to pass to the UI component
   * @returns The user's response
   */
  elicit<K extends keyof TElicits & string>(
    key: K,
    data: ElicitData
  ): Operation<ElicitResult<z.infer<TElicits[K]>>>
}

/**
 * Full tool context (sampling + elicitation).
 */
export type ToolContext<TElicits extends ElicitsMap> = TElicits extends Record<string, never>
  ? ToolContextWithSampling
  : ToolContextWithElicits<TElicits>

// =============================================================================
// PHANTOM TYPE CARRIERS
// =============================================================================

/**
 * Phantom type carrier for builder state.
 * Uses `in out` variance for bidirectional type flow (like TanStack Start).
 */
export interface ToolTypes<
  in out TParams,
  in out THandoff,
  in out TClient,
  in out TResult,
  in out TElicits extends ElicitsMap,
> {
  params: TParams
  handoff: THandoff
  client: TClient
  result: TResult
  elicits: TElicits
}

// =============================================================================
// HANDOFF CONFIGURATION
// =============================================================================

/**
 * Configuration for server→client→server handoff pattern.
 *
 * Type flow:
 * ```
 * TParams ──► before(params) → THandoff
 *                                │
 *        ┌───────────────────────┤
 *        ▼                       ▼
 * client(handoff, ctx, params) → TClient
 *        │                       │
 *        └───────► after(handoff, client, params) → TResult
 * ```
 */
export interface HandoffConfig<
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
> {
  /**
   * Phase 1: Server computes initial state.
   * Runs ONCE before client execution.
   */
  before: (params: TParams, ctx: ServerToolContext) => Operation<THandoff>

  /**
   * Client execution: Interact with LLM and/or user.
   * Has access to sampling and elicitation.
   */
  client: (
    handoff: THandoff,
    ctx: ToolContext<TElicits>,
    params: TParams
  ) => Operation<TClient>

  /**
   * Phase 2: Server validates and returns.
   * Runs ONCE after client execution.
   */
  after: (
    handoff: THandoff,
    client: TClient,
    ctx: ServerToolContext,
    params: TParams
  ) => Operation<TResult>
}

// =============================================================================
// EXECUTE FUNCTION TYPE
// =============================================================================

/**
 * Simple execute function (no handoff).
 */
export type ExecuteFn<TParams, TResult, TElicits extends ElicitsMap> = (
  params: TParams,
  ctx: ToolContext<TElicits>
) => Operation<TResult>

// =============================================================================
// FINALIZED TOOL
// =============================================================================

/**
 * Execution mode of a tool.
 */
export type ToolMode = 'execute' | 'handoff'

/**
 * A fully configured tool.
 */
export interface FinalizedTool<
  TName extends string,
  TParams,
  THandoff,
  TClient,
  TResult,
  TElicits extends ElicitsMap,
> {
  /** Phantom type carrier */
  _types: ToolTypes<TParams, THandoff, TClient, TResult, TElicits>

  /** Tool name (used by LLM) */
  name: TName

  /** Description (shown to LLM) */
  description: string

  /** Zod parameter schema */
  parameters: z.ZodType<TParams>

  /** Elicitation schemas (keyed map) */
  elicits: TElicits

  /** Execution mode */
  mode: ToolMode

  /** Execution limits */
  limits?: ToolLimits

  /** Handoff config (if mode === 'handoff') */
  handoffConfig?: HandoffConfig<TParams, THandoff, TClient, TResult, TElicits>

  /** Execute function (if mode === 'execute') */
  execute?: ExecuteFn<TParams, TResult, TElicits>
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Any tool (for arrays/registries).
 */
export type AnyTool = FinalizedTool<string, any, any, any, any, ElicitsMap>

/**
 * Extract the name from a tool.
 */
export type InferToolName<T> = T extends FinalizedTool<infer N, any, any, any, any, any>
  ? N
  : never

/**
 * Extract the params type from a tool.
 */
export type InferToolParams<T> = T extends FinalizedTool<any, infer P, any, any, any, any>
  ? P
  : never

/**
 * Extract the handoff type from a tool.
 */
export type InferToolHandoff<T> = T extends FinalizedTool<any, any, infer H, any, any, any>
  ? H
  : never

/**
 * Extract the client output type from a tool.
 */
export type InferToolClient<T> = T extends FinalizedTool<any, any, any, infer C, any, any>
  ? C
  : never

/**
 * Extract the result type from a tool.
 */
export type InferToolResult<T> = T extends FinalizedTool<any, any, any, any, infer R, any>
  ? R
  : never

/**
 * Extract the elicits map from a tool.
 */
export type InferToolElicits<T> = T extends FinalizedTool<any, any, any, any, any, infer E>
  ? E
  : never

// =============================================================================
// TOOL SCHEMA (for LLM registration)
// =============================================================================

/**
 * JSON Schema representation of a tool (for LLM).
 */
export interface ToolSchema {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}
