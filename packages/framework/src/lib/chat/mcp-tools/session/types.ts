/**
 * MCP Tool Session Types
 *
 * Interfaces for durable tool execution sessions that keep generators
 * alive across HTTP requests, supporting elicitation and sampling.
 *
 * ## Architecture
 *
 * ```
 * ToolSessionRegistry
 *   └─ create() → ToolSession
 *   └─ acquire(id) → ToolSession (refcount++)
 *   └─ release(id) → cleanup when refcount = 0
 *
 * ToolSession
 *   └─ id, toolName, status
 *   └─ events() → Stream of ToolSessionEvent
 *   └─ respondToElicit(id, response)
 *   └─ respondToSample(id, response)
 *   └─ cancel()
 *
 * ToolSessionStore
 *   └─ Pluggable storage (in-memory, Redis, Durable Objects)
 * ```
 *
 * @packageDocumentation
 */
import type { Operation, Stream } from 'effection'
import type {
  ElicitResult,
  SampleResult,
  Message,
  LogLevel,
  ElicitsMap,
} from '../mcp-tool-types'
import type { FinalizedMcpToolWithElicits } from '../mcp-tool-builder'

// Re-export SampleResult for convenience
export type { SampleResult } from '../mcp-tool-types'

// =============================================================================
// SESSION STATUS
// =============================================================================

/**
 * Status of a tool session.
 */
export type ToolSessionStatus =
  | 'initializing' // Session created, tool not yet started
  | 'running' // Tool is executing
  | 'awaiting_elicit' // Tool is waiting for user input
  | 'awaiting_sample' // Tool is waiting for LLM response
  | 'completed' // Tool finished successfully
  | 'failed' // Tool threw an error
  | 'cancelled' // Tool was cancelled by client

// =============================================================================
// SESSION EVENTS
// =============================================================================

/**
 * Base event with sequence number for resumability.
 */
interface ToolSessionEventBase {
  /** Logical sequence number for resumability */
  lsn: number
  /** Timestamp when event was created */
  timestamp: number
}

/**
 * Progress notification event.
 */
export interface ProgressEvent extends ToolSessionEventBase {
  type: 'progress'
  message: string
  progress?: number // 0-1
}

/**
 * Log message event.
 */
export interface LogEvent extends ToolSessionEventBase {
  type: 'log'
  level: LogLevel
  message: string
}

/**
 * Elicitation request event.
 * The session is now awaiting a response via respondToElicit().
 */
export interface ElicitRequestEvent extends ToolSessionEventBase {
  type: 'elicit_request'
  /** Unique ID for this elicitation (for correlation) */
  elicitId: string
  /** Elicitation key (matches tool's .elicits() declaration) */
  key: string
  /** Message to display to user */
  message: string
  /** JSON Schema for the expected response */
  schema: Record<string, unknown>
}

/**
 * Sampling request event.
 * The session is now awaiting a response via respondToSample().
 */
export interface SampleRequestEvent extends ToolSessionEventBase {
  type: 'sample_request'
  /** Unique ID for this sample request (for correlation) */
  sampleId: string
  /** Messages to send to LLM */
  messages: Message[]
  /** Optional system prompt */
  systemPrompt?: string
  /** Maximum tokens to generate */
  maxTokens?: number
}

/**
 * Tool completed successfully.
 */
export interface ResultEvent<TResult = unknown> extends ToolSessionEventBase {
  type: 'result'
  /** The tool's return value */
  result: TResult
}

/**
 * Tool failed with an error.
 */
export interface ErrorEvent extends ToolSessionEventBase {
  type: 'error'
  /** Error name */
  name: string
  /** Error message */
  message: string
  /** Optional stack trace (dev only) */
  stack?: string
}

/**
 * Tool was cancelled.
 */
export interface CancelledEvent extends ToolSessionEventBase {
  type: 'cancelled'
  /** Optional cancellation reason */
  reason?: string
}

/**
 * Internal event to wake up the SSE stream when a sample response is queued.
 */
export interface SampleResponseQueuedEvent {
  type: 'sample_response_queued'
  lsn: number
  timestamp: number
}

/**
 * All possible session events.
 */
export type ToolSessionEvent<TResult = unknown> =
  | ProgressEvent
  | LogEvent
  | ElicitRequestEvent
  | SampleRequestEvent
  | SampleResponseQueuedEvent
  | ResultEvent<TResult>
  | ErrorEvent
  | CancelledEvent

// =============================================================================
// TOOL SESSION
// =============================================================================

/**
 * A durable tool execution session.
 *
 * The session keeps the tool's generator alive across HTTP requests,
 * allowing elicitation and sampling to work over stateless HTTP.
 *
 * @template TResult - The tool's result type
 */
export interface ToolSession<TResult = unknown> {
  /** Unique session ID */
  readonly id: string

  /** Name of the tool being executed */
  readonly toolName: string

  /**
   * Get current session status.
   */
  status(): Operation<ToolSessionStatus>

  /**
   * Get session events as a stream.
   *
   * @param afterLSN - Only return events after this LSN (for resumability)
   * @returns Stream of events, completes when session ends
   */
  events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void>

  /**
   * Respond to an elicitation request.
   *
   * @param elicitId - The ID from the ElicitRequestEvent
   * @param response - The user's response
   */
  respondToElicit(elicitId: string, response: ElicitResult<unknown>): Operation<void>

  /**
   * Respond to a sampling request.
   *
   * @param sampleId - The ID from the SampleRequestEvent
   * @param response - The LLM's response
   */
  respondToSample(sampleId: string, response: SampleResult): Operation<void>

  /**
   * Emit an internal event to wake up the SSE stream.
   * Used when a sample response is queued from a different HTTP request scope.
   */
  emitWakeUp(): Operation<void>

  /**
   * Cancel the session.
   *
   * @param reason - Optional cancellation reason
   */
  cancel(reason?: string): Operation<void>
}

// =============================================================================
// TOOL SESSION OPTIONS
// =============================================================================

/**
 * Options for creating a tool session.
 */
export interface ToolSessionOptions {
  /** Custom session ID (auto-generated if not provided) */
  sessionId?: string

  /** Timeout for the entire session in milliseconds */
  timeout?: number

  /** Initial messages (parent context) */
  parentMessages?: Message[]

  /** System prompt */
  systemPrompt?: string

  /** Abort signal for external cancellation */
  signal?: AbortSignal
}

// =============================================================================
// TOOL SESSION REGISTRY
// =============================================================================

/**
 * Registry for managing tool sessions.
 *
 * Uses reference counting to track active clients and clean up
 * sessions when no longer needed.
 *
 * @template TResult - Default result type for sessions
 */
export interface ToolSessionRegistry {
  /**
   * Create a new tool session.
   *
   * @param tool - The tool to execute
   * @param params - Tool parameters
   * @param options - Session options
   * @returns The created session
   */
  create<TParams, THandoff, TClient, TResult, TElicits extends ElicitsMap>(
    tool: FinalizedMcpToolWithElicits<string, TParams, THandoff, TClient, TResult, TElicits>,
    params: TParams,
    options?: ToolSessionOptions
  ): Operation<ToolSession<TResult>>

  /**
   * Get a session by ID without acquiring it.
   * Returns null if session doesn't exist.
   */
  get(sessionId: string): Operation<ToolSession | null>

  /**
   * Acquire a session by ID (increments refcount).
   * Throws if session doesn't exist.
   */
  acquire(sessionId: string): Operation<ToolSession>

  /**
   * Release a session (decrements refcount).
   * Session is cleaned up when refcount reaches 0.
   */
  release(sessionId: string): Operation<void>
}

// =============================================================================
// TOOL SESSION STORE
// =============================================================================

/**
 * Entry stored for each session.
 */
export interface ToolSessionEntry<TResult = unknown> {
  /** The session instance */
  session: ToolSession<TResult>

  /** Reference count (number of active clients) */
  refCount: number

  /** When the session was created */
  createdAt: number

  /** Current status (cached for quick access) */
  status: ToolSessionStatus
}

/**
 * Pluggable storage for tool sessions.
 *
 * Implementations can use in-memory Map, Redis, or Durable Objects.
 */
export interface ToolSessionStore {
  /**
   * Get a session entry by ID.
   */
  get(sessionId: string): Operation<ToolSessionEntry | null>

  /**
   * Set a session entry.
   */
  set(sessionId: string, entry: ToolSessionEntry): Operation<void>

  /**
   * Delete a session entry.
   */
  delete(sessionId: string): Operation<void>

  /**
   * Update the reference count.
   * @returns The new refcount
   */
  updateRefCount(sessionId: string, delta: number): Operation<number>

  /**
   * Update the status.
   */
  updateStatus(sessionId: string, status: ToolSessionStatus): Operation<void>
}

// =============================================================================
// SAMPLING PROVIDER
// =============================================================================

/**
 * Provider for LLM sampling (server-side).
 *
 * This is called when a tool uses ctx.sample() and the session
 * needs to forward the request to an LLM.
 */
export interface ToolSessionSamplingProvider {
  /**
   * Request an LLM completion.
   */
  sample(
    messages: Message[],
    options?: { systemPrompt?: string; maxTokens?: number }
  ): Operation<SampleResult>
}

// =============================================================================
// TYPE HELPERS
// =============================================================================

/**
 * Extract the result type from a tool.
 */
export type InferToolSessionResult<T> = T extends ToolSession<infer R> ? R : never

/**
 * Any tool session (for arrays/registries).
 */
export type AnyToolSession = ToolSession<unknown>
