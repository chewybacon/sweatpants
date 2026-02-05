/**
 * Worker Transport - Operative Side (Host)
 *
 * When the host acts as the operative, it handles requests from the worker.
 * The worker (principal) sends sample/elicit requests, and the host (operative)
 * processes them and returns responses.
 *
 * ## Architecture
 *
 * Returns a standard `OperativeTransport` that bridges @effectionx/worker's
 * callback pattern to the channel-based Transport interface:
 * - Iterator yields incoming `TransportRequest` from the worker
 * - `send()` routes `ProgressMessage` to `ctx.progress()` and `ResponseMessage` to forEach return
 *
 * ## Usage
 *
 * ```typescript
 * const workerOp = yield* createWorkerOperative({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 * });
 *
 * // Access transport for messaging (standard interface)
 * const transport = workerOp.transport;
 *
 * // Handle requests
 * yield* spawn(function* () {
 *   for (const request of yield* each(transport)) {
 *     if (request.kind === 'sample') {
 *       const response = yield* handleSample(request);
 *       yield* transport.send({
 *         type: 'response',
 *         id: request.id,
 *         kind: 'sample',
 *         response: { status: 'accepted', content: result },
 *       });
 *     }
 *     yield* each.next();
 *   }
 * });
 *
 * // Await final result from worker
 * const toolResult = yield* workerOp;
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
  OperativeTransport,
  OperativeIncoming,
  OperativeOutgoing,
  TransportRequest,
  ResponseMessage,
  RequestKind,
} from "../../types/transport.ts";
import { isProgressMessage, isResponseMessage } from "../../types/transport.ts";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WorkerInitData,
  WorkerProgressMessage,
  WorkerOperativeResult,
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
 * Options for creating a worker operative (host handles requests from worker).
 */
export interface WorkerOperativeOptions {
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

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Create a worker operative transport (host handles requests from worker).
 *
 * In this configuration:
 * - Worker acts as principal (sends sample/elicit requests)
 * - Host acts as operative (handles requests via transport interface)
 *
 * Returns an object that is both:
 * - Has a `transport` property (standard OperativeTransport interface)
 * - Is an Operation that yields the final WorkerResult<T> when awaited
 *
 * @param options - Worker configuration
 * @returns WorkerOperativeResult with transport and result via [Symbol.iterator]
 */
export function* createWorkerOperative<T = unknown>(
  options: WorkerOperativeOptions
): Operation<WorkerOperativeResult<T>> {
  const { workerUrl, initData } = options;

  return yield* resource<WorkerOperativeResult<T>>(function* (provide) {
    // Create the worker using @effectionx/worker
    const worker: WorkerResource<never, never, WorkerResult<T>> =
      yield* useWorker<never, never, WorkerResult<T>, WorkerInitData>(
        workerUrl,
        {
          type: "module",
          data: initData,
        }
      );

    // Channel for incoming requests (from worker to host)
    const incomingChannel: Channel<OperativeIncoming, void> =
      createChannel<OperativeIncoming, void>();

    // Map request ID -> { ctx, responseChannel }
    // Used to bridge send() calls back to the forEach callback
    const pendingRequests = new Map<
      string,
      {
        ctx: ForEachContext<WorkerProgressMessage>;
        responseChannel: Channel<ResponseMessage<RequestKind>, void>;
      }
    >();

    // Spawn the forEach handler to bridge callback pattern to channel pattern
    yield* spawn(function* () {
      try {
        yield* worker.forEach<WorkerRequest, WorkerResponse, WorkerProgressMessage>(
          function* (workerRequest, ctx) {
            // Create response channel for this request
            const responseChannel = createChannel<ResponseMessage<RequestKind>, void>();
            pendingRequests.set(workerRequest.id, { ctx, responseChannel });

            // Convert WorkerRequest to TransportRequest and put in incoming channel
            const transportRequest: TransportRequest<RequestKind> = {
              id: workerRequest.id,
              kind: workerRequest.type as RequestKind, // "sample" | "elicit"
              type: workerRequest.type,
              payload: workerRequest,
            };
            yield* incomingChannel.send(transportRequest);

            // Wait for response via send()
            const responseSub: Subscription<ResponseMessage<RequestKind>, void> =
              yield* responseChannel;
            const result = yield* responseSub.next();

            // Clean up
            pendingRequests.delete(workerRequest.id);

            if (result.done) {
              // Channel closed without response - shouldn't happen
              throw new Error(`No response received for request ${workerRequest.id}`);
            }

            // Convert ResponseMessage back to WorkerResponse
            const responseMessage = result.value;
            return toWorkerResponse(workerRequest.id, responseMessage);
          }
        );
      } finally {
        // Worker forEach completed, close incoming channel
        yield* incomingChannel.close();
      }
    });

    // Get subscription from incoming channel
    const subscription: Subscription<OperativeIncoming, void> =
      yield* incomingChannel;

    // Build the transport
    const transport: OperativeTransport = {
      *[Symbol.iterator]() {
        return subscription;
      },

      *send(message: OperativeOutgoing): Operation<void> {
        if (isProgressMessage(message)) {
          // Route progress to ctx.progress()
          const pending = pendingRequests.get(message.id);
          if (pending) {
            const messageStr = typeof message.data === "string" 
              ? message.data 
              : (message.data as { message?: string })?.message ?? "";
            const progressValue = (message.data as { progress?: number })?.progress;
            
            const progressData: WorkerProgressMessage = {
              type: "progress",
              message: messageStr,
            };
            
            // Only add progress if defined (exactOptionalPropertyTypes)
            if (progressValue !== undefined) {
              progressData.progress = progressValue;
            }
            
            yield* pending.ctx.progress(progressData);
          }
        } else if (isResponseMessage(message)) {
          // Route response to responseChannel to unblock forEach callback
          const pending = pendingRequests.get(message.id);
          if (pending) {
            yield* pending.responseChannel.send(message);
          }
        }
      },
    };

    // Create result object that is also an Operation
    const result: WorkerOperativeResult<T> = {
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
 * Convert ResponseMessage to WorkerResponse.
 */
function toWorkerResponse(id: string, message: ResponseMessage<RequestKind>): WorkerResponse {
  if (message.kind === "sample") {
    const response = message.response as { status: string; content?: unknown };
    if (response.status === "accepted") {
      const content = response.content as {
        text?: string;
        model?: string;
        stopReason?: string;
        parsed?: unknown;
        parseError?: { message: string; rawText: string };
        toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
      };
      return {
        id,
        type: "sample",
        status: "accepted",
        text: content?.text ?? "",
        ...(content?.model !== undefined && { model: content.model }),
        ...(content?.stopReason !== undefined && { stopReason: content.stopReason }),
        ...(content?.parsed !== undefined && { parsed: content.parsed }),
        ...(content?.parseError !== undefined && { parseError: content.parseError }),
        ...(content?.toolCalls !== undefined && { toolCalls: content.toolCalls }),
      };
    }
  }
  
  if (message.kind === "elicit") {
    const response = message.response as { status: string; content?: unknown };
    return {
      id,
      type: "elicit",
      status: response.status as "accepted" | "declined" | "cancelled",
      ...(response.status === "accepted" && { content: response.content }),
    };
  }

  // Fallback - shouldn't happen with proper typing
  throw new Error(`Unknown response kind: ${message.kind}`);
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
