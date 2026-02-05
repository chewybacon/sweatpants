/**
 * Worker Transport Types for Tool Sessions
 *
 * Defines types for running tool generators in isolated workers using
 * @effectionx/worker with progress streaming and backpressure.
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication:
 * - Worker (Principal) sends requests via send.stream()
 * - Host (Operative) receives requests via worker.forEach()
 * - Progress flows from Host → Worker with backpressure via ctx.progress()
 *
 * ```
 * Worker (Principal)                    Host (Operative)
 * ────────────────────────────────────────────────────────────
 *                                        │
 * ctx.sample({ prompt })                 │
 *   │                                    │
 *   │── send.stream(request) ──────────►│
 *                                        │ worker.forEach((req, ctx) => ...)
 *   │◄── ctx.progress(update) ──────────│ (with backpressure)
 *   │◄── response ──────────────────────│
 *                                        │
 * yield* workerResult ◄──────────────────│ return finalResult
 * ```
 *
 * ## Progress with Backpressure
 *
 * Tool's ctx.progress() calls send a request to the host, which emits
 * the progress event and returns an ack. This provides natural backpressure -
 * if the host is slow, the worker naturally slows down.
 *
 * ## Cancellation
 *
 * Uses Effection's structured concurrency - closing the worker resource
 * cleanly shuts down the worker scope.
 *
 * @packageDocumentation
 */

import type { Operation } from 'effection'
import type { z } from 'zod'
import type {
  Message,
  ExtendedMessage,
  LogLevel,
  RawSampleResult,
  RawSampleResultBase,
  RawSampleResultWithParsed,
  RawSampleResultWithToolCalls,
  ElicitResult,
  RawElicitResult,
  SamplingToolDefinition,
  SamplingToolChoice,
  SamplingToolCall,
  ModelPreferences,
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleToolsResult,
  SampleSchemaResult,
} from '../mcp-tool-types.ts'

// =============================================================================
// WORKER INIT DATA
// =============================================================================

/**
 * Initialization data passed to the worker.
 */
export interface McpWorkerInitData {
  /** Tool name to look up in the registry */
  toolName: string
  /** Tool parameters (JSON-serializable) */
  params: unknown
  /** Session ID for correlation */
  sessionId: string
  /** Optional system prompt */
  systemPrompt?: string
  /** Optional parent messages */
  parentMessages?: Message[]
}

// =============================================================================
// WORKER REQUESTS (Worker → Host)
// =============================================================================

/**
 * Base request interface with ID for correlation.
 */
interface McpRequestBase {
  /** Unique ID for correlation */
  id: string
}

/**
 * Progress notification request from the tool.
 * Worker sends this and waits for ack (backpressure).
 */
export interface McpProgressRequest extends McpRequestBase {
  type: 'progress'
  /** Human-readable progress message */
  message: string
  /** Optional progress value 0-1 */
  progress?: number
}

/**
 * Log message request from the tool.
 * Fire-and-forget (no backpressure).
 */
export interface McpLogRequest extends McpRequestBase {
  type: 'log'
  level: LogLevel
  message: string
}

/**
 * Sample request - tool is requesting LLM sampling.
 */
export interface McpSampleRequest extends McpRequestBase {
  type: 'sample'
  /** Messages to send to LLM. Supports ExtendedMessage for tool call history. */
  messages: ExtendedMessage[]
  /** Optional system prompt */
  systemPrompt?: string
  /** Maximum tokens to generate */
  maxTokens?: number
  /** Model preferences for the client */
  modelPreferences?: ModelPreferences
  /** Tool definitions for tool calling */
  tools?: SamplingToolDefinition[]
  /** How the model should choose tools */
  toolChoice?: SamplingToolChoice
  /** JSON Schema for structured output */
  schema?: Record<string, unknown>
}

/**
 * Elicit request - tool is requesting user input.
 */
export interface McpElicitRequest extends McpRequestBase {
  type: 'elicit'
  /** Elicitation key */
  key: string
  /** Message to display to user */
  message: string
  /** JSON Schema for expected response */
  schema: Record<string, unknown>
  /** Context data for the UI to render (e.g., flight options, seat map) */
  context?: Record<string, unknown>
}

/**
 * All request types the worker can send to the host.
 */
export type McpWorkerRequest =
  | McpProgressRequest
  | McpLogRequest
  | McpSampleRequest
  | McpElicitRequest

// =============================================================================
// WORKER RESPONSES (Host → Worker)
// =============================================================================

/**
 * Ack response for progress requests.
 */
export interface McpProgressResponse {
  type: 'progress'
  ack: true
}

/**
 * Ack response for log requests.
 */
export interface McpLogResponse {
  type: 'log'
  ack: true
}

/**
 * Sample response from the host.
 */
export interface McpSampleResponse {
  type: 'sample'
  /** The LLM's response (raw result without exchange) */
  result: RawSampleResult
}

/**
 * Elicit response from the host.
 */
export interface McpElicitResponse {
  type: 'elicit'
  /** The user's response */
  result: RawElicitResult<unknown>
}

/**
 * All response types the host can send to the worker.
 */
export type McpWorkerResponse =
  | McpProgressResponse
  | McpLogResponse
  | McpSampleResponse
  | McpElicitResponse

// =============================================================================
// HOST PROGRESS (Host → Worker, in-band via @effectionx/worker)
// =============================================================================

/**
 * Progress message sent from host to worker during request processing.
 * Uses @effectionx/worker's built-in progress streaming with backpressure.
 */
export interface McpHostProgress {
  type: 'host_progress'
  /** Human-readable status message */
  message: string
  /** Optional progress value 0-1 */
  progress?: number
}

// =============================================================================
// WORKER RESULT
// =============================================================================

/**
 * Successful result from the worker.
 */
export interface McpWorkerSuccessResult<T = unknown> {
  type: 'success'
  value: T
}

/**
 * Error result from the worker.
 */
export interface McpWorkerErrorResult {
  type: 'error'
  error: {
    name: string
    message: string
    stack?: string
  }
}

/**
 * Cancelled result from the worker.
 */
export interface McpWorkerCancelledResult {
  type: 'cancelled'
  reason?: string
}

/**
 * Result from the worker - success, error, or cancelled.
 */
export type McpWorkerResult<T = unknown> =
  | McpWorkerSuccessResult<T>
  | McpWorkerErrorResult
  | McpWorkerCancelledResult

// =============================================================================
// TOOL REGISTRY FOR WORKERS
// =============================================================================

/**
 * Registry of tools available to workers.
 *
 * Workers need access to tool handlers. This registry is initialized
 * in the worker with the same tools as the main thread.
 */
export interface WorkerToolRegistry {
  /**
   * Get a tool by name.
   * Returns null if tool doesn't exist.
   */
  get(name: string): WorkerTool | null

  /**
   * List all registered tool names.
   */
  list(): string[]
}

/**
 * Minimal tool interface for workers.
 *
 * Workers don't need the full FinalizedMcpToolWithElicits type,
 * just enough to execute the handler.
 */
export interface WorkerTool {
  name: string
  handler: (params: unknown, ctx: WorkerToolContext) => Generator<unknown, unknown, unknown>
}

// =============================================================================
// WORKER SAMPLE CONFIG TYPES
// =============================================================================

/**
 * Base sample configuration for workers.
 */
interface WorkerSampleConfigBase {
  /** Optional system prompt override */
  systemPrompt?: string

  /** Maximum tokens to generate */
  maxTokens?: number

  /** Model preferences for the client */
  modelPreferences?: ModelPreferences
}

/**
 * Plain sample config - no schema or tools.
 */
interface WorkerSampleConfigPlain extends WorkerSampleConfigBase {
  schema?: never
  tools?: never
  toolChoice?: never
}

/**
 * Sample config with structured output schema.
 * @template T - The type of the parsed output
 */
interface WorkerSampleConfigWithSchema<T = unknown> extends WorkerSampleConfigBase {
  /**
   * Zod schema for structured output.
   * Will be serialized to JSON schema for transport.
   */
  schema: z.ZodType<T>
  tools?: never
  toolChoice?: never
}

/**
 * Sample config with tool definitions.
 */
interface WorkerSampleConfigWithTools extends WorkerSampleConfigBase {
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[]
  /** How the model should choose tools */
  toolChoice?: SamplingToolChoice
  schema?: never
}

/**
 * Sample with prompt string.
 */
interface WorkerSampleConfigPromptMode {
  /** The prompt to send */
  prompt: string
  messages?: never
}

/**
 * Sample with explicit messages array.
 * Supports ExtendedMessage for tool call history.
 */
interface WorkerSampleConfigMessagesMode {
  /** Explicit messages array. Supports ExtendedMessage with tool_use/tool_result. */
  messages: ExtendedMessage[]
  prompt?: never
}

/** Plain sample with prompt */
export type WorkerSampleConfigPlainPrompt = WorkerSampleConfigPlain & WorkerSampleConfigPromptMode

/** Plain sample with messages */
export type WorkerSampleConfigPlainMessages = WorkerSampleConfigPlain & WorkerSampleConfigMessagesMode

/** Schema sample with prompt */
export type WorkerSampleConfigSchemaPrompt<T = unknown> = WorkerSampleConfigWithSchema<T> & WorkerSampleConfigPromptMode

/** Schema sample with messages */
export type WorkerSampleConfigSchemaMessages<T = unknown> = WorkerSampleConfigWithSchema<T> & WorkerSampleConfigMessagesMode

/** Tools sample with prompt */
export type WorkerSampleConfigToolsPrompt = WorkerSampleConfigWithTools & WorkerSampleConfigPromptMode

/** Tools sample with messages */
export type WorkerSampleConfigToolsMessages = WorkerSampleConfigWithTools & WorkerSampleConfigMessagesMode

/**
 * Full sample config union type for workers.
 * Matches McpToolSampleConfig from mcp-tool-types.ts.
 */
export type WorkerSampleConfig =
  | WorkerSampleConfigPlainPrompt
  | WorkerSampleConfigPlainMessages
  | WorkerSampleConfigSchemaPrompt
  | WorkerSampleConfigSchemaMessages
  | WorkerSampleConfigToolsPrompt
  | WorkerSampleConfigToolsMessages

// =============================================================================
// WORKER SAMPLE HELPER CONFIG TYPES
// =============================================================================

/**
 * Base config for sample helpers with retry support.
 */
interface WorkerSampleHelperConfigBase extends WorkerSampleConfigBase {
  /**
   * Number of retry attempts if validation fails.
   * @default 2
   */
  retries?: number
}

/**
 * Config for sampleTools helper with prompt.
 */
export interface WorkerSampleToolsConfig extends WorkerSampleHelperConfigBase {
  /** The prompt to send */
  prompt: string
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[]
  /** How the model should choose tools. @default 'required' */
  toolChoice?: SamplingToolChoice
}

/**
 * Config for sampleTools helper with messages.
 */
export interface WorkerSampleToolsConfigMessages extends WorkerSampleHelperConfigBase {
  /** Explicit messages array */
  messages: ExtendedMessage[]
  /** Tools available for the model to call */
  tools: SamplingToolDefinition[]
  /** How the model should choose tools. @default 'required' */
  toolChoice?: SamplingToolChoice
}

/**
 * Config for sampleSchema helper with prompt.
 */
export interface WorkerSampleSchemaConfig<T> extends WorkerSampleHelperConfigBase {
  /** The prompt to send */
  prompt: string
  /** Zod schema for structured output */
  schema: z.ZodType<T>
}

/**
 * Config for sampleSchema helper with messages.
 */
export interface WorkerSampleSchemaConfigMessages<T> extends WorkerSampleHelperConfigBase {
  /** Explicit messages array */
  messages: ExtendedMessage[]
  /** Zod schema for structured output */
  schema: z.ZodType<T>
}

// =============================================================================
// WORKER TOOL CONTEXT
// =============================================================================

/**
 * Tool context available in workers.
 *
 * Provides full MCP sampling and elicitation capabilities over the transport boundary.
 * Matches the McpToolContext interface from mcp-tool-types.ts.
 *
 * ## Progress with Backpressure
 *
 * Unlike the old fire-and-forget model, progress() now sends a request to the host
 * and waits for an ack. This provides backpressure - if the host is slow to process
 * events, the worker naturally slows down.
 */
export interface WorkerToolContext {
  /**
   * Log a message.
   * Fire-and-forget (no backpressure).
   */
  log(level: LogLevel, message: string): void

  /**
   * Send a progress notification.
   * Blocks until the host acknowledges (backpressure).
   */
  progress(message: string, progress?: number): Operation<void>

  // ---------------------------------------------------------------------------
  // Sample overloads - match McpToolContext signature
  // ---------------------------------------------------------------------------

  /**
   * Plain sample (no schema, no tools) - returns base result.
   */
  sample(config: WorkerSampleConfigPlainPrompt | WorkerSampleConfigPlainMessages): Operation<SampleResultBase>

  /**
   * Schema sample - returns result with parsed field.
   */
  sample<T>(config: WorkerSampleConfigSchemaPrompt<T> | WorkerSampleConfigSchemaMessages<T>): Operation<SampleResultWithParsed<T>>

  /**
   * Tools sample - returns result with toolCalls field.
   */
  sample(config: WorkerSampleConfigToolsPrompt | WorkerSampleConfigToolsMessages): Operation<SampleResultWithToolCalls>

  /**
   * Generic sample - returns appropriate result type based on config.
   */
  sample(config: WorkerSampleConfig): Operation<SampleResultBase | SampleResultWithParsed<unknown> | SampleResultWithToolCalls>

  // ---------------------------------------------------------------------------
  // Sample helpers with retry logic
  // ---------------------------------------------------------------------------

  /**
   * Sample with guaranteed tool calls.
   * Retries if the model doesn't return tool calls.
   *
   * @throws SampleValidationError if no tool calls after retries
   */
  sampleTools(config: WorkerSampleToolsConfig | WorkerSampleToolsConfigMessages): Operation<SampleToolsResult>

  /**
   * Sample with guaranteed parsed schema.
   * Retries if parsing/validation fails.
   *
   * @throws SampleValidationError if parsing fails after retries
   */
  sampleSchema<T>(config: WorkerSampleSchemaConfig<T> | WorkerSampleSchemaConfigMessages<T>): Operation<SampleSchemaResult<T>>

  // ---------------------------------------------------------------------------
  // Elicitation
  // ---------------------------------------------------------------------------

  /**
   * Request user input.
   * Suspends until response is received via transport.
   */
  elicit<T>(
    key: string,
    options: { message: string; schema: Record<string, unknown>; context?: Record<string, unknown> }
  ): Operation<ElicitResult<unknown, T>>
}

// =============================================================================
// RE-EXPORT TYPES FOR CONVENIENCE
// =============================================================================

export type {
  // Message types
  Message,
  ExtendedMessage,
  // Raw result types (wire format)
  RawSampleResult,
  RawSampleResultBase,
  RawSampleResultWithParsed,
  RawSampleResultWithToolCalls,
  RawElicitResult,
  // Full result types (with exchange)
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleToolsResult,
  SampleSchemaResult,
  ElicitResult,
  // Tool types
  SamplingToolDefinition,
  SamplingToolCall,
  SamplingToolChoice,
  ModelPreferences,
  LogLevel,
}
