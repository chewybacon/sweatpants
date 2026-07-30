/**
 * Worker Transport Types for Tool Sessions
 *
 * Defines types for running tool generators in isolated workers using
 * @effectionx/worker request/response channels.
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication:
 * - Worker sends sample/elicit requests via send.stream(request)
 * - Host receives requests via worker.forEach()
 * - Host sends a ready ACK, then returns exactly one final response per request
 *
 * ```
 * Worker (Principal)                    Host (Operative)
 * ────────────────────────────────────────────────────────────
 *                                        │
 * ctx.sample({ prompt })                 │
 *   │                                    │
 *   │── send.stream(request) ──────────►│
 *                                        │ worker.forEach((req, ctx) => ...)
 *   │◄── ready ACK ─────────────────────│
 *   │◄── response ──────────────────────│
 *                                        │
 * yield* workerResult ◄──────────────────│ return finalResult
 * ```
 *
 * ## Cancellation
 *
 * Uses Effection's structured concurrency - closing the worker resource
 * cleanly shuts down the worker scope.
 *
 * @packageDocumentation
 */

import type { Operation } from "effection";
import type { LogLevel, ToolElicitResult, ToolSamplingCtx } from "@sweatpants/agent-sdk";
import type { JsonObject } from "@sweatpants/foundation";
import type { ExtendedMessage } from "@sweatpants/tool-session/messages";

// =============================================================================
// WORKER INIT DATA
// =============================================================================

/**
 * Initialization data passed to the worker.
 */
export interface McpWorkerInitData {
  /** Tool name to look up in the registry */
  toolName: string;
  /** Tool parameters (JSON-serializable) */
  params: unknown;
  /** Session ID for correlation */
  sessionId: string;
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
  get(name: string): WorkerTool | null;

  /**
   * List all registered tool names.
   */
  list(): string[];
}

/**
 * Minimal tool interface for workers.
 *
 * Workers don't need the full ToolDefinition type,
 * just enough to execute the handler.
 */
export interface WorkerTool {
  name: string;
  /** Portable response projections computed once when the tool was authored. */
  elicitSchemas: Readonly<Record<string, JsonObject>>;
  handler: (params: unknown, ctx: WorkerToolContext) => Operation<unknown>;
}

// =============================================================================
// WORKER TOOL CONTEXT
// =============================================================================

/**
 * Tool context available in workers.
 *
 * Provides full sampling and elicitation capabilities over the transport boundary.
 * It mirrors the canonical tool-facing context surface plus worker-specific
 * transport concerns.
 *
 * Notifications use the canonical tool-context `notify` operation.
 */
export interface WorkerToolContext extends ToolSamplingCtx<ExtendedMessage> {
  /** Scope-owned cancellation signal inherited from the worker invocation. */
  readonly signal: AbortSignal;

  /**
   * Log a message.
   * Fire-and-forget (no backpressure).
   * Returns Operation<void> so callers can use yield* ctx.log(...).
   */
  log(level: LogLevel, message: string): Operation<void>;

  /** Send a canonical tool progress notification. */
  notify(message: string, progress?: number, level?: LogLevel): Operation<void>;

  // ---------------------------------------------------------------------------
  // Authored sampling is inherited from Agent SDK and specialized to ExtendedMessage.

  // Elicitation
  // ---------------------------------------------------------------------------

  /**
   * Request user input.
   * Suspends until response is received via transport.
   */
  elicit<T>(
    key: string,
    options: {
      message: string;
      schema?: Record<string, unknown>;
      context?: Record<string, unknown>;
    },
  ): Operation<ToolElicitResult<unknown, T>>;
}
