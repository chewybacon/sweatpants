/**
 * MCP Tool Session Types
 *
 * Interfaces for durable tool execution sessions that keep generators
 * alive across HTTP requests, supporting elicitation and sampling.
 *
 * ## Architecture
 *
 * ```
 * ToolInvocationHost
 *   └─ start() / turn() → control cranks
 *   └─ dispose() → resource cleanup
 *
 * ToolSession (private runtime resource)
 *   └─ projection.events() → pull-only event projection
 *   └─ resume({ kind, requestId, response }) → execution advancement
 * ```
 *
 * @packageDocumentation
 */
import type { Operation, Stream } from "effection";
import type { Json, JsonObject } from "@sweatpants/foundation";
import type { ChatMessage, ChatToolDefinition } from "@sweatpants/chat-contract";
import type { ToolInvocationResume } from "./invocation-resume.ts";
import type { ToolSessionModelSelection } from "./model-selection.ts";
import type {
  LogLevel,
  ModelPreferences,
  SamplingToolChoice,
  SampleExchangeCompletionBase,
  ParsedSampleExchangeCompletion,
  ToolCallSampleExchangeCompletion,
} from "@sweatpants/agent-sdk";

// =============================================================================
// SESSION STATUS
// =============================================================================

/**
 * Status of a tool session.
 */
export type ToolSessionStatus =
  | "initializing" // Session created, tool not yet started
  | "running" // Tool is executing
  | "awaiting_elicit" // Tool is waiting for user input
  | "awaiting_sample" // Tool is waiting for LLM response
  | "completed" // Tool finished successfully
  | "failed" // Tool threw an error
  | "cancelled" // Tool was cancelled by client
  | "orphaned"; // Remote session state was lost and cannot be resumed

// =============================================================================
// SESSION EVENTS
// =============================================================================

/**
 * Base event with sequence number for resumability.
 */
interface ToolSessionEventBase {
  /** Logical sequence number for resumability */
  lsn: number;
  /** Timestamp when event was created */
  timestamp: number;
}

/**
 * Progress notification event.
 */
export interface ProgressEvent extends ToolSessionEventBase {
  type: "progress";
  message: string;
  progress?: number; // 0-1
}

/**
 * Log message event.
 */
export interface LogEvent extends ToolSessionEventBase {
  type: "log";
  level: LogLevel;
  message: string;
}

/**
 * Elicitation request event.
 * The session is now awaiting a response via respondToElicit().
 */
export interface ElicitRequestEvent extends ToolSessionEventBase {
  type: "elicit_request";
  /** Unique ID for this elicitation (for correlation) */
  elicitId: string;
  /** Elicitation key (matches tool's .elicits() declaration) */
  key: string;
  /** Human-readable message to display to the user */
  message: string;
  /** JSON Schema for the expected response */
  schema: JsonObject;
  /** Context data for the UI to render (e.g., flight options, seat map) */
  context?: Json;
}

/**
 * Sampling request event.
 * The session is now awaiting a response via respondToSample().
 */
export interface SampleRequestEvent extends ToolSessionEventBase {
  type: "sample_request";
  /** Unique ID for this sample request (for correlation) */
  sampleId: string;
  /** Messages to send to LLM (supports tool call/result messages) */
  messages: ChatMessage[];
  /** Optional system prompt */
  systemPrompt?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Model preferences for the client */
  modelPreferences?: ModelPreferences;
  /** Retained portable tool definitions for tool calling. */
  tools?: ChatToolDefinition[];
  /** How the model should choose tools */
  toolChoice?: SamplingToolChoice;
  /** JSON Schema projection for structured output. */
  schema?: JsonObject;
}

/**
 * Tool completed successfully.
 */
export interface ResultEvent<TResult extends Json = Json> extends ToolSessionEventBase {
  type: "result";
  /** The tool's return value */
  result: TResult;
}

/**
 * Tool failed with an error.
 */
export interface ErrorEvent extends ToolSessionEventBase {
  type: "error";
  /** Error name */
  name: string;
  /** Error message */
  message: string;
  /** Optional stack trace (dev only) */
  stack?: string;
}

/**
 * Tool was cancelled.
 */
export interface CancelledEvent extends ToolSessionEventBase {
  type: "cancelled";
  /** Optional cancellation reason */
  reason?: string;
}

/**
 * Internal event to wake up the SSE stream when a sample response is queued.
 */
export interface SampleResponseQueuedEvent {
  type: "sample_response_queued";
  lsn: number;
  timestamp: number;
}

/**
 * All possible session events.
 */
export type ToolSessionEvent<TResult extends Json = Json> =
  | ProgressEvent
  | LogEvent
  | ElicitRequestEvent
  | SampleRequestEvent
  | SampleResponseQueuedEvent
  | ResultEvent<TResult>
  | ErrorEvent
  | CancelledEvent;

// =============================================================================
// TOOL INVOCATION EVENT PROJECTION
// =============================================================================

/**
 * Pull-only reader for an invocation's replayable event projection.
 *
 * The projection includes UX notices, parked asks, and terminal outcomes.
 * Reading it never resumes the generator or advances invocation control.
 */
export interface ToolInvocationEventReader<TResult extends Json = Json> {
  events(afterLSN?: number): Stream<ToolSessionEvent<TResult>, void>;
}

/** Lookup for pull-only invocation event projections. */
export interface ToolInvocationEventSource {
  open(invocationId: string): Operation<ToolInvocationEventReader | null>;
}

// =============================================================================
// TOOL SESSION
// =============================================================================

/**
 * Private runtime resource retained by a ToolInvocationHost.
 *
 * It keeps the live generator and replayable event projection together across
 * request scopes. Callers use ToolInvocationHost for control; projection reads
 * cannot answer, cancel, or otherwise advance the generator.
 *
 * @template TResult - The tool's result type
 */
export interface ToolSession<TResult extends Json = Json> {
  /** Unique session ID */
  readonly id: string;

  /** Name of the tool being executed */
  readonly toolName: string;

  /**
   * Get current session status.
   */
  status(): Operation<ToolSessionStatus>;

  /** Resolves when the session reaches a terminal status; no timer polling. */
  settled?(): Operation<ToolSessionStatus>;

  /** Pull-only replayable events. This reader does not control the invocation. */
  readonly projection: ToolInvocationEventReader<TResult>;

  /**
   * Resume the private execution resource and advance its parked generator.
   * The host is the public control surface. This single operation is the only
   * response and cancellation entry point below it.
   */
  resume(resume: ToolInvocationResume): Operation<void>;
}

// =============================================================================
// TOOL SESSION OPTIONS
// =============================================================================

/**
 * Options for creating a tool session.
 */
export interface ToolSessionOptions {
  /** Custom session ID (auto-generated if not provided) */
  sessionId?: string;

  /** Timeout for the entire session in milliseconds */
  timeout?: number;

  /** System prompt */
  systemPrompt?: string;

  /** Selected chat model identity for runtimes that support inherited sampling. */
  model?: ToolSessionModelSelection;

  /** Abort signal for external cancellation */
  signal?: AbortSignal;

  /**
   * Start tool execution immediately when the session is created.
   *
   * When true, tool execution begins in the scope where the session is created
   * (typically the registry's long-lived scope), not when events() is first
   * subscribed. This is required for multi-step elicitation across HTTP
   * request boundaries.
   *
   * When false (default), execution is deferred until events() is subscribed,
   * which is appropriate for SSE streaming where the subscriber's scope
   * stays alive for the duration of the stream.
   *
   * @default false
   */
  startImmediately?: boolean;
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
   *
   * @param messages - Messages to send to the LLM
   * @param options - Sampling options including tools and schema
   * @returns The LLM response (raw result without exchange)
   */
  sample(
    messages: ChatMessage[],
    options?: ToolSessionSamplingOptions,
  ): Operation<
    | SampleExchangeCompletionBase
    | ParsedSampleExchangeCompletion<unknown>
    | ToolCallSampleExchangeCompletion
  >;
}

/**
 * Options for sampling requests.
 */
export interface ToolSessionSamplingOptions {
  /** System prompt */
  systemPrompt?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Retained portable tool definitions for tool calling. */
  tools?: ChatToolDefinition[];
  /** How the model should choose tools */
  toolChoice?: SamplingToolChoice;
  /** JSON Schema projection for structured output. */
  schema?: JsonObject;
}
