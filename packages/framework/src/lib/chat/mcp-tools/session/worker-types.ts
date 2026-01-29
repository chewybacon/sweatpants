/**
 * Worker Transport Types for Tool Sessions
 *
 * Defines interfaces for running tool generators in isolated workers
 * with pub/sub communication. The transport abstraction allows different
 * backends: Node.js worker_threads, Cloudflare Durable Objects, etc.
 *
 * ## Architecture
 *
 * ```
 * Main Thread                           Worker Thread
 * ────────────────────────────────────────────────────────────
 * SessionWorkerHost                     SessionWorkerRunner
 *   │                                     │
 *   │ ──── StartMessage ──────────────► │
 *   │                                     │ run(toolGenerator)
 *   │ ◄──── ProgressMessage ─────────── │
 *   │ ◄──── SampleRequestMessage ────── │
 *   │                                     │ yield* waitForMessage()
 *   │ ──── SampleResponseMessage ─────► │
 *   │                                     │ (resumes)
 *   │ ◄──── ResultMessage ───────────── │
 *   │                                     │ (exits)
 * ```
 *
 * ## Design Principles
 *
 * - Transport is message-based (postMessage-style)
 * - All messages are JSON-serializable
 * - Worker runs until tool completes (never preemptively killed)
 * - Effection runs independently in each thread
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
// WORKER MESSAGES (Host → Worker)
// =============================================================================

/**
 * Start the tool execution.
 * Sent once when the worker is created.
 */
export interface StartMessage {
  type: 'start'
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

/**
 * Response to a sampling request.
 */
export interface SampleResponseMessage {
  type: 'sample_response'
  /** Correlates with SampleRequestMessage.sampleId */
  sampleId: string
  /** The LLM's response (raw result without exchange) */
  response: RawSampleResult
}

/**
 * Response to an elicitation request.
 */
export interface ElicitResponseMessage {
  type: 'elicit_response'
  /** Correlates with ElicitRequestMessage.elicitId */
  elicitId: string
  /** The user's response */
  response: RawElicitResult<unknown>
}

/**
 * Cancel the tool execution.
 */
export interface CancelMessage {
  type: 'cancel'
  /** Optional cancellation reason */
  reason?: string
}

/**
 * All messages the host can send to the worker.
 */
export type HostToWorkerMessage =
  | StartMessage
  | SampleResponseMessage
  | ElicitResponseMessage
  | CancelMessage

// =============================================================================
// WORKER MESSAGES (Worker → Host)
// =============================================================================

/**
 * Worker is ready to receive the start message.
 */
export interface ReadyMessage {
  type: 'ready'
}

/**
 * Progress notification from the tool.
 */
export interface ProgressMessage {
  type: 'progress'
  /** Human-readable progress message */
  message: string
  /** Optional progress value 0-1 */
  progress?: number
  /** Event sequence number */
  lsn: number
}

/**
 * Log message from the tool.
 */
export interface LogMessage {
  type: 'log'
  level: LogLevel
  message: string
  lsn: number
}

/**
 * Tool is requesting LLM sampling.
 * Worker will pause until SampleResponseMessage is received.
 */
export interface SampleRequestMessage {
  type: 'sample_request'
  /** Unique ID for correlation */
  sampleId: string
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
  lsn: number
}

/**
 * Tool is requesting user input.
 * Worker will pause until ElicitResponseMessage is received.
 */
export interface ElicitRequestMessage {
  type: 'elicit_request'
  /** Unique ID for correlation */
  elicitId: string
  /** Elicitation key */
  key: string
  /** Message to display to user */
  message: string
  /** JSON Schema for expected response */
  schema: Record<string, unknown>
  lsn: number
}

/**
 * Tool completed successfully.
 */
export interface ResultMessage {
  type: 'result'
  /** The tool's return value */
  result: unknown
  lsn: number
}

/**
 * Tool failed with an error.
 */
export interface ErrorMessage {
  type: 'error'
  name: string
  message: string
  stack?: string
  lsn: number
}

/**
 * Tool was cancelled.
 */
export interface CancelledMessage {
  type: 'cancelled'
  reason?: string
  lsn: number
}

/**
 * All messages the worker can send to the host.
 */
export type WorkerToHostMessage =
  | ReadyMessage
  | ProgressMessage
  | LogMessage
  | SampleRequestMessage
  | ElicitRequestMessage
  | ResultMessage
  | ErrorMessage
  | CancelledMessage

// =============================================================================
// TRANSPORT INTERFACE
// =============================================================================

/**
 * Unsubscribe function returned by subscribe().
 */
export type Unsubscribe = () => void

/**
 * Transport interface for worker communication.
 *
 * This is the abstraction that allows different backends:
 * - Node.js worker_threads
 * - Cloudflare Durable Objects + WebSocket
 * - In-process (for testing)
 *
 * Both the host and worker use this interface, but with different
 * message type parameters.
 */
export interface SessionWorkerTransport<TSend, TReceive> {
  /**
   * Send a message to the other side.
   * This is fire-and-forget (no acknowledgment).
   */
  send(message: TSend): void

  /**
   * Subscribe to messages from the other side.
   * Returns an unsubscribe function.
   */
  subscribe(handler: (message: TReceive) => void): Unsubscribe

  /**
   * Close the transport.
   * After this, send() and subscribe() should not be called.
   */
  close(): void
}

/**
 * Transport from the host's perspective.
 */
export type HostTransport = SessionWorkerTransport<HostToWorkerMessage, WorkerToHostMessage>

/**
 * Transport from the worker's perspective.
 */
export type WorkerTransport = SessionWorkerTransport<WorkerToHostMessage, HostToWorkerMessage>

// =============================================================================
// TRANSPORT FACTORY
// =============================================================================

/**
 * Factory for creating worker transports.
 *
 * Different implementations create the transport differently:
 * - WorkerThreadTransportFactory: Spawns a new worker_threads.Worker
 * - DurableObjectTransportFactory: Creates a Durable Object and WebSocket
 * - InProcessTransportFactory: Creates a pair of in-memory transports
 */
export interface SessionWorkerTransportFactory {
  /**
   * Create a new worker and return the host-side transport.
   *
   * @param workerPath - Path to the worker entry point (for worker_threads)
   * @param sessionId - Session ID for the worker
   * @returns The host-side transport
   */
  create(workerPath: string, sessionId: string): Operation<HostTransport>
}

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
 */
export interface WorkerToolContext {
  /**
   * Log a message.
   */
  log(level: LogLevel, message: string): void

  /**
   * Send a progress notification.
   */
  progress(message: string, progress?: number): void

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
    options: { message: string; schema: Record<string, unknown> }
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
  // Full result types (with exchange)
  SampleResultBase,
  SampleResultWithParsed,
  SampleResultWithToolCalls,
  SampleToolsResult,
  SampleSchemaResult,
  // Tool types
  SamplingToolDefinition,
  SamplingToolCall,
  SamplingToolChoice,
  ModelPreferences,
}
