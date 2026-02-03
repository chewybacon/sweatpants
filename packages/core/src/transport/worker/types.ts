/**
 * Worker Transport Types
 *
 * Defines the message protocol for web worker communication using @effectionx/worker.
 * This transport enables running tool sessions in isolated web workers for both
 * browser and Node.js environments.
 *
 * ## Communication Model
 *
 * Uses @effectionx/worker's bidirectional communication with progress streaming:
 * - Worker sends requests via send.stream() and receives progress + response
 * - Host receives requests via worker.forEach() and sends progress via ctx.progress()
 *
 * ## Message Flow
 *
 * ```
 * Host (Main Thread)                    Worker Thread
 * ─────────────────────────────────────────────────────────
 *   │                                      │
 *   │ ──── useWorker(url, { data }) ────► │ workerMain()
 *   │                                      │
 *   │ ◄──── send.stream(request) ──────── │ (worker initiates)
 *   │                                      │
 *   │ worker.forEach((req, ctx) => ...)   │
 *   │ ───── ctx.progress(update) ───────► │ (in-band, with backpressure)
 *   │ ───── return response ────────────► │ (final value)
 *   │                                      │
 *   │ ◄──── yield* worker (Result) ────── │ return finalResult
 * ```
 *
 * @packageDocumentation
 */

import type { Operation } from "effection";
import type { 
  PrincipalTransport, 
  OperativeTransport,
} from "../../types/transport.ts";

// =============================================================================
// REQUEST/RESPONSE MESSAGES (via worker.send())
// =============================================================================

/**
 * Base interface for all requests sent to the worker.
 */
export interface WorkerRequestBase {
  /** Unique request ID for correlation */
  id: string;
}

/**
 * Sample request - ask the LLM for a response.
 */
export interface WorkerSampleRequest extends WorkerRequestBase {
  type: "sample";
  /** Messages to send to LLM */
  messages: WorkerMessage[];
  /** Optional system prompt */
  systemPrompt?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Model preferences */
  modelPreferences?: WorkerModelPreferences;
  /** Tool definitions for tool calling */
  tools?: WorkerToolDefinition[];
  /** How the model should choose tools */
  toolChoice?: WorkerToolChoice;
  /** JSON Schema for structured output */
  schema?: Record<string, unknown>;
}

/**
 * Elicit request - ask the user for input.
 */
export interface WorkerElicitRequest extends WorkerRequestBase {
  type: "elicit";
  /** Elicitation key */
  key: string;
  /** Message to display to user */
  message: string;
  /** JSON Schema for expected response */
  schema: Record<string, unknown>;
}

/**
 * Union of all request types sent via worker.send().
 */
export type WorkerRequest = WorkerSampleRequest | WorkerElicitRequest;

/**
 * Base interface for all responses received from worker.send().
 */
export interface WorkerResponseBase {
  /** Request ID this response correlates to */
  id: string;
}

/**
 * Successful sample response.
 */
export interface WorkerSampleResponse extends WorkerResponseBase {
  type: "sample";
  status: "accepted";
  /** The LLM's response text */
  text: string;
  /** Model that generated the response */
  model?: string;
  /** Why generation stopped */
  stopReason?: string;
  /** Parsed structured output (if schema was provided) */
  parsed?: unknown;
  /** Parse error details (if parsing failed) */
  parseError?: { message: string; rawText: string };
  /** Tool calls (if tools were provided) */
  toolCalls?: WorkerToolCall[];
}

/**
 * Elicit response - user's answer.
 */
export interface WorkerElicitResponse extends WorkerResponseBase {
  type: "elicit";
  status: "accepted" | "declined" | "cancelled";
  /** User's response content (only if accepted) */
  content?: unknown;
}

/**
 * Union of all response types received from worker.send().
 */
export type WorkerResponse = WorkerSampleResponse | WorkerElicitResponse;

// =============================================================================
// PROGRESS MESSAGES (in-band via ctx.progress())
// =============================================================================

/**
 * Progress notification sent during request processing.
 * Sent in-band via ctx.progress() with backpressure support.
 * The worker receives these as subscription values before the final response.
 */
export interface WorkerProgressMessage {
  type: "progress";
  /** Human-readable progress message */
  message: string;
  /** Optional progress value 0-1 */
  progress?: number;
}

/**
 * Log message from the worker.
 * Currently logged locally in the worker.
 */
export interface WorkerLogMessage {
  type: "log";
  /** Log level */
  level: "debug" | "info" | "warning" | "error";
  /** Log message */
  message: string;
}

/**
 * Union of progress and log message types.
 */
export type WorkerOutOfBandMessage = WorkerProgressMessage | WorkerLogMessage;

// =============================================================================
// WORKER INITIALIZATION DATA
// =============================================================================

/**
 * Data passed to the worker during initialization via useWorker's data option.
 */
export interface WorkerInitData {
  /** Tool name to execute */
  toolName: string;
  /** Tool parameters */
  params: unknown;
  /** Session ID for correlation */
  sessionId: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional parent messages for context */
  parentMessages?: WorkerMessage[];
}

// =============================================================================
// WORKER FINAL RESULT
// =============================================================================

/**
 * Successful tool completion.
 */
export interface WorkerSuccessResult<T = unknown> {
  type: "success";
  /** The tool's return value */
  value: T;
}

/**
 * Tool execution error.
 */
export interface WorkerErrorResult {
  type: "error";
  /** Error details */
  error: {
    name: string;
    message: string;
    stack: string | undefined;
  };
}

/**
 * Tool was cancelled.
 */
export interface WorkerCancelledResult {
  type: "cancelled";
  /** Optional cancellation reason */
  reason?: string;
}

/**
 * Union of all possible final results from the worker.
 */
export type WorkerResult<T = unknown> =
  | WorkerSuccessResult<T>
  | WorkerErrorResult
  | WorkerCancelledResult;

// =============================================================================
// SUPPORTING TYPES
// =============================================================================

/**
 * Message role in a conversation.
 */
export type WorkerMessageRole = "user" | "assistant";

/**
 * Simple text content block.
 */
export interface WorkerTextContent {
  type: "text";
  text: string;
}

/**
 * Tool use content block (assistant requesting to call a tool).
 */
export interface WorkerToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result content block (user providing tool output).
 */
export interface WorkerToolResultContent {
  type: "tool_result";
  toolUseId: string;
  content: WorkerTextContent[];
  isError?: boolean;
}

/**
 * Content block in a message.
 */
export type WorkerContentBlock =
  | WorkerTextContent
  | WorkerToolUseContent
  | WorkerToolResultContent;

/**
 * A message in the conversation.
 * Supports both simple string content and complex content blocks.
 */
export interface WorkerMessage {
  role: WorkerMessageRole;
  content: string | WorkerContentBlock[];
}

/**
 * Model preferences for sampling.
 */
export interface WorkerModelPreferences {
  /** Preferred model hints */
  hints?: Array<{ name?: string }>;
  /** Cost priority (0-1) */
  costPriority?: number;
  /** Speed priority (0-1) */
  speedPriority?: number;
  /** Intelligence priority (0-1) */
  intelligencePriority?: number;
}

/**
 * Tool definition for sampling.
 */
export interface WorkerToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** JSON Schema for tool input */
  inputSchema: Record<string, unknown>;
}

/**
 * How the model should choose tools.
 */
export type WorkerToolChoice = "auto" | "none" | "required" | { type: "tool"; name: string };

/**
 * A tool call made by the model.
 */
export interface WorkerToolCall {
  /** Unique ID for this tool call */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments */
  arguments: Record<string, unknown>;
}

// =============================================================================
// WORKER CONTEXT INTERFACE
// =============================================================================

/**
 * Context provided to tool handlers running in the worker.
 */
export interface WorkerToolContext {
  /**
   * Sample the LLM.
   */
  sample(options: Omit<WorkerSampleRequest, "id" | "type">): Operation<WorkerSampleResponse>;

  /**
   * Request user input via elicitation.
   */
  elicit<T = unknown>(
    key: string,
    options: { message: string; schema: Record<string, unknown> }
  ): Operation<WorkerElicitResponse & { content?: T }>;

  /**
   * Send a progress notification (fire-and-forget).
   */
  progress(message: string, progress?: number): void;

  /**
   * Log a message (fire-and-forget).
   */
  log(level: WorkerLogMessage["level"], message: string): void;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Check if a message is a worker progress message.
 */
export function isWorkerProgressMessage(msg: unknown): msg is WorkerProgressMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as WorkerProgressMessage).type === "progress"
  );
}

/**
 * Check if a message is a worker log message.
 */
export function isWorkerLogMessage(msg: unknown): msg is WorkerLogMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    (msg as WorkerLogMessage).type === "log"
  );
}

/**
 * Check if a message is a worker out-of-band message.
 */
export function isWorkerOutOfBandMessage(msg: unknown): msg is WorkerOutOfBandMessage {
  return isWorkerProgressMessage(msg) || isWorkerLogMessage(msg);
}

// =============================================================================
// TRANSPORT RESULT TYPES
// =============================================================================

/**
 * Progress data sent via the transport.
 * Used with core ProgressMessage<WorkerProgressData>.
 */
export interface WorkerProgressData {
  /** Human-readable progress message */
  message: string;
  /** Optional progress value 0-1 */
  progress?: number;
}

/**
 * Result of creating a worker operative transport.
 * 
 * This is both:
 * - An object with a `transport` property (standard OperativeTransport interface)
 * - An Operation that yields the final WorkerResult<T> when awaited
 * 
 * @example
 * ```typescript
 * const workerOp = yield* createWorkerOperative({ ... });
 * 
 * // Access transport for messaging
 * const transport = workerOp.transport;
 * 
 * // Await final result
 * const result = yield* workerOp;
 * ```
 */
export type WorkerOperativeResult<T = unknown> = Operation<WorkerResult<T>> & {
  /** Standard operative transport interface */
  transport: OperativeTransport;
};

/**
 * Result of creating a worker principal transport.
 * 
 * This is both:
 * - An object with a `transport` property (standard PrincipalTransport interface)
 * - An Operation that yields the final WorkerResult<T> when awaited
 * 
 * @example
 * ```typescript
 * const workerOp = yield* createWorkerPrincipal({ ... });
 * 
 * // Access transport for messaging
 * const transport = workerOp.transport;
 * 
 * // Await final result
 * const result = yield* workerOp;
 * ```
 */
export type WorkerPrincipalResult<T = unknown> = Operation<WorkerResult<T>> & {
  /** Standard principal transport interface */
  transport: PrincipalTransport;
};
