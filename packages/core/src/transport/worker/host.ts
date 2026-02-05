/**
 * Host-Side Worker Transport
 *
 * Implements the host (main thread) side of the web worker transport using
 * @effectionx/worker. This creates a CorrelatedTransport that tools can use
 * unchanged.
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication:
 * - Worker sends requests via send.stream() (sample/elicit)
 * - Host receives requests via worker.forEach() 
 * - Host sends progress via ctx.progress()
 * - Host returns response from the forEach handler
 *
 * ## Usage
 *
 * ```typescript
 * const { transport, result } = yield* createWorkerPrincipal({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 *   requestHandler: function* (request, ctx) {
 *     // Send progress updates
 *     yield* ctx.progress({ type: "progress", message: "Processing..." });
 *     
 *     // Handle the request and return response
 *     if (request.type === "sample") {
 *       const response = yield* callLLM(request);
 *       return response;
 *     }
 *     // ... handle other request types
 *   }
 * });
 *
 * // Wait for final result
 * const toolResult = yield* result;
 * ```
 *
 * @packageDocumentation
 */

import {
  resource,
  spawn,
  type Operation,
} from "effection";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WorkerInitData,
  WorkerProgressMessage,
} from "./types.ts";

// Re-define ForEachContext locally since TypeScript has trouble resolving it
// from the PR-based package. This matches the interface from @effectionx/worker.
export interface ForEachContext<TProgress> {
  progress(data: TProgress): Operation<void>;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Handler function for processing worker requests.
 * Receives the request and a context for sending progress updates.
 */
export type WorkerRequestHandler = (
  request: WorkerRequest,
  ctx: ForEachContext<WorkerProgressMessage>
) => Operation<WorkerResponse>;

/**
 * Options for creating a worker principal transport.
 */
export interface WorkerPrincipalOptions {
  /**
   * URL or path to the worker script.
   * Must be a module worker (type: "module").
   */
  workerUrl: string | URL;

  /**
   * Initialization data passed to the worker.
   */
  initData: WorkerInitData;

  /**
   * Handler for processing requests from the worker.
   * This is called for each sample/elicit request.
   */
  requestHandler: WorkerRequestHandler;
}

/**
 * Result of creating a worker principal.
 */
export interface WorkerPrincipalResult<T = unknown> {
  /**
   * Operation that yields the final result from the worker.
   * Await this to get the tool's return value.
   */
  result: Operation<WorkerResult<T>>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a worker principal transport using @effectionx/worker.
 *
 * This function:
 * 1. Spawns a web worker with the given URL and init data
 * 2. Uses worker.forEach() to handle requests from the worker
 * 3. Calls the requestHandler for each request, allowing progress updates
 * 4. Returns an operation for the final result
 *
 * @param options - Worker configuration including request handler
 * @returns WorkerPrincipalResult with result operation
 */
export function* createWorkerPrincipal<T = unknown>(
  options: WorkerPrincipalOptions
): Operation<WorkerPrincipalResult<T>> {
  const { workerUrl, initData, requestHandler } = options;

  return yield* resource<WorkerPrincipalResult<T>>(function* (provide) {
    let outcome: WorkerResult<T> | null = null;
    let resultSettled = false;
    // Create the worker using @effectionx/worker
    // Type parameters:
    // TSend = never (host doesn't send requests via worker.send() in our model)
    // TRecv = never (host doesn't receive responses to its sends)
    // TReturn = WorkerResult<T> (final return value from worker)
    // TData = WorkerInitData (init data)
    const worker: WorkerResource<never, never, WorkerResult<T>> =
      yield* useWorker<never, never, WorkerResult<T>, WorkerInitData>(
        workerUrl,
        {
          type: "module",
          data: initData,
        }
      );

    // Spawn the forEach handler to process worker requests
    // This runs in the background and handles all requests from the worker
    yield* spawn(function* () {
      try {
        // Use worker.forEach with the progress-enabled signature
        // WRequest = WorkerRequest (what worker sends)
        // WResponse = WorkerResponse (what we send back)
        // WProgress = WorkerProgressMessage (progress updates)
        yield* worker.forEach<WorkerRequest, WorkerResponse, WorkerProgressMessage>(
          function* (request, ctx) {
            // Call the user-provided request handler
            return yield* requestHandler(request, ctx);
          }
        );
      } catch (error) {
        if (!resultSettled) {
          const err = error as Error;
          outcome = {
            type: "error",
            error: {
              name: err.name,
              message: err.message,
              stack: err.stack,
            },
          };
          resultSettled = true;
        }
      }
    });

    // Create result operation wrapper
    const resultOperation: Operation<WorkerResult<T>> = {
      *[Symbol.iterator]() {
        if (resultSettled && outcome) {
          return outcome;
        }

        try {
          // Yield the worker's final result
          const result = yield* worker;
          if (!resultSettled) {
            outcome = result;
            resultSettled = true;
          }
          return result;
        } catch (error) {
          if (!resultSettled) {
            const err = error as Error;
            outcome = {
              type: "error",
              error: {
                name: err.name,
                message: err.message,
                stack: err.stack,
              },
            };
            resultSettled = true;
          }
          return outcome as WorkerResult<T>;
        }
      },
    };

    // Provide the result operation
    yield* provide({
      result: resultOperation,
    });
  });
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate a unique request ID.
 */
export function generateRequestId(prefix = "req"): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

// =============================================================================
// CONVENIENCE HELPERS
// =============================================================================

/**
 * Helper to create a sample response.
 */
export function createSampleResponse(
  id: string,
  options: {
    text: string;
    model?: string;
    stopReason?: string;
    parsed?: unknown;
    parseError?: { message: string; rawText: string };
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  }
): WorkerResponse {
  const response: WorkerResponse = {
    id,
    type: "sample",
    status: "accepted",
    text: options.text,
  };
  
  // Only add optional properties if they are defined (for exactOptionalPropertyTypes)
  if (options.model !== undefined) {
    (response as { model?: string }).model = options.model;
  }
  if (options.stopReason !== undefined) {
    (response as { stopReason?: string }).stopReason = options.stopReason;
  }
  if (options.parsed !== undefined) {
    (response as { parsed?: unknown }).parsed = options.parsed;
  }
  if (options.parseError !== undefined) {
    (response as { parseError?: { message: string; rawText: string } }).parseError = options.parseError;
  }
  if (options.toolCalls !== undefined) {
    (response as { toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }).toolCalls = options.toolCalls;
  }
  
  return response;
}

/**
 * Helper to create an elicit response.
 */
export function createElicitResponse(
  id: string,
  options: {
    status: "accepted" | "declined" | "cancelled";
    content?: unknown;
  }
): WorkerResponse {
  if (options.status === "accepted") {
    return {
      id,
      type: "elicit",
      status: "accepted",
      content: options.content,
    };
  }
  return {
    id,
    type: "elicit",
    status: options.status,
  };
}
