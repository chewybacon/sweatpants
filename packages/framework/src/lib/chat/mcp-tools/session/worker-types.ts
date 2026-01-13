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
import type {
  Message,
  LogLevel,
  SampleResult,
  ElicitResult,
  SamplingToolDefinition,
  SamplingToolChoice,
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
  /** The LLM's response */
  response: SampleResult
}

/**
 * Response to an elicitation request.
 */
export interface ElicitResponseMessage {
  type: 'elicit_response'
  /** Correlates with ElicitRequestMessage.elicitId */
  elicitId: string
  /** The user's response */
  response: ElicitResult<unknown, unknown>
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
  /** Messages to send to LLM */
  messages: Message[]
  /** Optional system prompt */
  systemPrompt?: string
  /** Maximum tokens to generate */
  maxTokens?: number
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

/**
 * Tool context available in workers.
 *
 * This is a subset of McpToolContext that works over the transport boundary.
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

  /**
   * Request LLM sampling.
   * Suspends until response is received via transport.
   */
  sample(
    messages: Message[],
    options?: { systemPrompt?: string; maxTokens?: number }
  ): Operation<SampleResult>

  /**
   * Request user input.
   * Suspends until response is received via transport.
   */
  elicit<T>(
    key: string,
    options: { message: string; schema: Record<string, unknown> }
  ): Operation<ElicitResult<unknown, T>>
}
