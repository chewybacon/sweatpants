/**
 * Worker Transport - Principal Side (Host)
 *
 * When the host acts as the principal, it sends requests to the worker.
 * The host (principal) sends sample/elicit requests, and the worker (operative)
 * processes them and returns responses.
 *
 * ## Architecture
 *
 * Returns a standard `PrincipalTransport` that bridges @effectionx/worker's
 * messaging pattern to the channel-based Transport interface:
 * - `send()` routes requests to the worker
 * - Iterator yields incoming responses from the worker
 *
 * ## Limitations
 *
 * Unlike the operative configuration, progress streaming is limited in this
 * direction. The worker can only return final responses via messages.forEach().
 *
 * ## Usage
 *
 * ```typescript
 * const workerOp = yield* createWorkerPrincipal({
 *   workerUrl: "./request-handler-worker.js",
 *   initData: { sessionId: "123", toolName: "handler", params: {} },
 * });
 *
 * // Access transport (standard PrincipalTransport interface)
 * const transport = workerOp.transport;
 *
 * // Send requests via transport
 * yield* spawn(function* () {
 *   yield* transport.send({
 *     id: "req-1",
 *     kind: "sample",
 *     type: "sample",
 *     payload: { messages: [{ role: "user", content: "Hello" }] },
 *   });
 *
 *   // Receive responses
 *   for (const message of yield* each(transport)) {
 *     if (message.type === 'response') {
 *       // Handle response
 *     }
 *     yield* each.next();
 *   }
 * });
 *
 * // Await final result from worker
 * const finalResult = yield* workerOp;
 * ```
 *
 * @packageDocumentation
 */

import {
  resource,
  spawn,
  createChannel,
  type Operation,
  type Channel,
  type Subscription,
} from "effection";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import type {
  PrincipalTransport,
  PrincipalIncoming,
  PrincipalOutgoing,
  RequestKind,
  SampleResponse,
  ElicitResponse,
} from "../../types/transport.ts";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WorkerInitData,
  WorkerPrincipalResult,
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
 * Legacy transport interface - kept for backwards compatibility.
 * Prefer using the standard PrincipalTransport via workerOp.transport.
 */
export interface WorkerPrincipalTransport {
  /**
   * Send a request to the worker and wait for response.
   * Note: No progress streaming available in this direction.
   */
  request(request: Omit<WorkerRequest, "id">): Operation<WorkerResponse>;
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
 * Returns an object that is both:
 * - Has a `transport` property (standard PrincipalTransport interface)
 * - Is an Operation that yields the final WorkerResult<T> when awaited
 *
 * @param options - Worker configuration
 * @returns WorkerPrincipalResult with transport and result via [Symbol.iterator]
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

    // Channel for incoming responses (from worker to host)
    const incomingChannel: Channel<PrincipalIncoming, void> =
      createChannel<PrincipalIncoming, void>();

    // Request ID counter
    let requestIdCounter = 0;

    /**
     * Generate a unique request ID.
     */
    function generateRequestId(): string {
      return `host:req:${++requestIdCounter}`;
    }

    // Get subscription from incoming channel
    const subscription: Subscription<PrincipalIncoming, void> =
      yield* incomingChannel;

    // Build the transport
    const transport: PrincipalTransport = {
      *[Symbol.iterator]() {
        return subscription;
      },

      *send(message: PrincipalOutgoing): Operation<void> {
        // PrincipalOutgoing is TransportRequest<RequestKind>
        // Convert to WorkerRequest and send to worker
        const workerRequest: WorkerRequest = {
          id: message.id || generateRequestId(),
          type: message.kind, // "sample" | "elicit"
          ...message.payload as object,
        } as WorkerRequest;

        // Spawn a task to send request and route response to channel
        yield* spawn(function* () {
          try {
            // worker.send() returns the response from the worker's forEach handler
            const workerResponse: WorkerResponse = yield* worker.send(workerRequest);

            // Convert WorkerResponse to ResponseMessage and send to channel
            const responseMessage: PrincipalIncoming = {
              type: "response",
              id: workerResponse.id,
              kind: workerResponse.type as RequestKind,
              response: toResponsePayload(workerResponse),
            };

            yield* incomingChannel.send(responseMessage);
          } catch (error) {
            // If worker throws, convert to error response
            const errorResponse: PrincipalIncoming = {
              type: "response",
              id: workerRequest.id,
              kind: workerRequest.type as RequestKind,
              response: {
                status: "error",
                error: error instanceof Error ? error.message : String(error),
              } as never, // Type assertion needed since error isn't a standard response
            };
            yield* incomingChannel.send(errorResponse);
          }
        });
      },
    };

    // Create result object that is also an Operation
    const result: WorkerPrincipalResult<T> = {
      transport,
      *[Symbol.iterator]() {
        return yield* worker;
      },
    };

    yield* provide(result);
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert WorkerResponse to the payload format expected by ResponseByKind.
 */
function toResponsePayload(response: WorkerResponse): SampleResponse | ElicitResponse {
  if (response.type === "sample") {
    return {
      status: "accepted",
      content: {
        text: response.text,
        model: response.model,
        stopReason: response.stopReason,
        parsed: response.parsed,
        parseError: response.parseError,
        toolCalls: response.toolCalls,
      },
    } satisfies SampleResponse;
  }

  if (response.type === "elicit") {
    if (response.status === "accepted") {
      return {
        status: "accepted",
        content: response.content,
      } satisfies ElicitResponse;
    } else if (response.status === "declined") {
      return { status: "declined" } satisfies ElicitResponse;
    } else {
      return { status: "cancelled" } satisfies ElicitResponse;
    }
  }

  // Fallback - shouldn't happen with proper typing
  return { status: "cancelled" } satisfies ElicitResponse;
}
