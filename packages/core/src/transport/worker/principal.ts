/**
 * Worker Transport - Principal Side (Host)
 *
 * When the host acts as the principal, it sends requests to the worker.
 * The host (principal) sends sample/elicit requests, and the worker (operative)
 * processes them and returns responses.
 *
 * ## Architecture
 *
 * Uses @effectionx/worker's bidirectional communication:
 * - Host (principal) sends requests via worker.send()
 * - Worker (operative) receives requests via messages.forEach()
 * - Worker (operative) processes and returns responses
 * - Host (principal) receives responses
 *
 * ## Limitations
 *
 * Unlike the operative configuration, there is no built-in progress streaming
 * from worker to host in this direction. The worker can only return final responses.
 *
 * ## Usage
 *
 * ```typescript
 * const { transport, result } = yield* createWorkerPrincipal({
 *   workerUrl: "./request-handler-worker.js",
 *   initData: { sessionId: "123" },
 * });
 *
 * // Send a request to the worker
 * const response = yield* transport.request({
 *   type: "sample",
 *   messages: [{ role: "user", content: "Hello" }]
 * });
 *
 * // Wait for worker to finish
 * const finalResult = yield* result;
 * ```
 *
 * @packageDocumentation
 */

import {
  resource,
  type Operation,
} from "effection";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WorkerInitData,
} from "./types.ts";

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Options for creating a worker principal (host sends requests to worker).
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
}

/**
 * Transport interface for sending requests to the worker.
 */
export interface WorkerPrincipalTransport {
  /**
   * Send a request to the worker and wait for response.
   * Note: No progress streaming available in this direction.
   */
  request(request: Omit<WorkerRequest, "id">): Operation<WorkerResponse>;
}

/**
 * Result of creating a worker principal.
 */
export interface WorkerPrincipalResult<T = unknown> {
  /**
   * Transport for sending requests to the worker.
   */
  transport: WorkerPrincipalTransport;

  /**
   * Operation that yields the final result from the worker.
   * Await this to get the worker's return value.
   */
  result: Operation<WorkerResult<T>>;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a worker principal transport (host sends requests to worker).
 *
 * In this configuration:
 * - Host acts as principal (sends sample/elicit requests)
 * - Worker acts as operative (handles requests, returns responses)
 *
 * This function:
 * 1. Spawns a web worker with the given URL and init data
 * 2. Provides a transport for sending requests to the worker
 * 3. Returns an operation for the final result
 *
 * Note: Progress streaming is not available in this direction due to
 * limitations in @effectionx/worker's messages.forEach() API.
 *
 * @param options - Worker configuration
 * @returns WorkerPrincipalResult with transport and result operation
 */
export function* createWorkerPrincipal<T = unknown>(
  options: WorkerPrincipalOptions
): Operation<WorkerPrincipalResult<T>> {
  const { workerUrl, initData } = options;

  return yield* resource<WorkerPrincipalResult<T>>(function* (provide) {
    // Create the worker using @effectionx/worker
    // In this model:
    // - Host sends WorkerRequest via worker.send()
    // - Worker processes via messages.forEach() and returns WorkerResponse
    const worker: WorkerResource<WorkerRequest, WorkerResponse, WorkerResult<T>> =
      yield* useWorker<WorkerRequest, WorkerResponse, WorkerResult<T>, WorkerInitData>(
        workerUrl,
        {
          type: "module",
          data: initData,
        }
      );

    // Request ID counter
    let requestIdCounter = 0;

    /**
     * Generate a unique request ID.
     */
    function generateRequestId(): string {
      return `host:req:${++requestIdCounter}`;
    }

    // Create the transport
    const transport: WorkerPrincipalTransport = {
      *request(requestWithoutId: Omit<WorkerRequest, "id">): Operation<WorkerResponse> {
        const id = generateRequestId();
        const request = { ...requestWithoutId, id } as WorkerRequest;

        // Send the request to the worker and get the response directly
        // worker.send() returns Operation<WorkerResponse> - the worker's forEach handler
        // processes the request and returns a response
        const response: WorkerResponse = yield* worker.send(request);
        
        return response;
      },
    };

    // Create result operation wrapper
    const resultOperation: Operation<WorkerResult<T>> = {
      *[Symbol.iterator]() {
        return yield* worker;
      },
    };

    // Provide the transport and result
    yield* provide({
      transport,
      result: resultOperation,
    });
  });
}
