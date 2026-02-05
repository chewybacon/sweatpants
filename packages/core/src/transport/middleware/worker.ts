/**
 * Worker Transport Middleware
 *
 * Web Worker-based transport middleware using @effectionx/worker.
 * Enables running tool sessions in isolated web workers for both
 * browser and Node.js environments.
 *
 * ## Key Differences from Other Middleware
 *
 * Workers are unique in that they:
 * 1. Return a final result when the worker completes
 * 2. Have bidirectional communication with progress streaming
 *
 * To handle this, the middleware factories return a resource with both
 * `middleware` (for transport) and an Operation to get the final result.
 *
 * ## Usage
 *
 * ```typescript
 * // Principal side (host sends requests to worker)
 * const workerResource = yield* WorkerPrincipal({
 *   workerUrl: "./worker.js",
 *   initData: { toolName: "greet", params: {}, sessionId: "123" },
 * });
 * const principal = yield* initTransport(workerResource.middleware);
 *
 * // Use transport
 * const response = yield* principal.request({ kind: "sample", ... });
 *
 * // Get final result when worker completes
 * const result = yield* workerResource.result();
 *
 * // Operative side (host handles requests from worker)
 * const workerResource = yield* WorkerOperative({
 *   workerUrl: "./worker.js",
 *   initData: { toolName: "greet", params: {}, sessionId: "123" },
 * });
 * const operative = yield* initTransport(workerResource.middleware);
 *
 * // Handle requests from worker
 * for (const req of yield* each(yield* operative.stream())) {
 *   yield* operative.send({ type: "response", id: req.id, ... });
 *   yield* each.next();
 * }
 *
 * // Get final result when worker completes
 * const result = yield* workerResource.result();
 * ```
 *
 * @packageDocumentation
 */

import {
  resource,
  spawn,
  createChannel,
  each,
  type Operation,
  type Channel,
  type Stream,
  type Subscription,
} from "effection";
import { useWorker, type WorkerResource } from "@effectionx/worker";
import type {
  PrincipalOutgoing,
  PrincipalIncoming,
  OperativeOutgoing,
  OperativeIncoming,
  TransportRequest,
  ResponseMessage,
  RequestKind,
  ResponseByKind,
} from "../../types/transport.ts";
import { isProgressMessage, isResponseMessage } from "../../types/transport.ts";
import type {
  WorkerRequest,
  WorkerResponse,
  WorkerResult,
  WorkerInitData,
  WorkerProgressMessage,
} from "../worker/types.ts";
import {
  generateRequestId,
  type TransportMiddleware,
  type TransportRequestWithoutId,
} from "../api.ts";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for Worker transport.
 */
export interface WorkerOptions {
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
 * Worker resource returned by WorkerPrincipal/WorkerOperative.
 *
 * Provides both the middleware for transport and access to the final result.
 */
export interface WorkerTransportResource<T = unknown> {
  /**
   * Middleware Operation for use with TransportApi.decorate().
   */
  middleware: Operation<TransportMiddleware>;

  /**
   * Get the final result when the worker completes.
   * This is an Operation that yields when the worker returns.
   */
  result(): Operation<WorkerResult<T>>;
}

/**
 * Pending request waiting for response (for principal correlation).
 */
interface PendingRequest {
  channel: Channel<never, ResponseByKind[RequestKind]>;
}

/**
 * ForEach context interface matching @effectionx/worker.
 */
interface ForEachContext<TProgress> {
  progress(data: TProgress): Operation<void>;
}

// =============================================================================
// WORKER PRINCIPAL
// =============================================================================

/**
 * Create a Worker principal resource (host sends requests to worker).
 *
 * In this configuration:
 * - Host acts as principal (sends sample/elicit requests)
 * - Worker acts as operative (handles requests, returns responses)
 *
 * @param options - Worker configuration
 * @returns Operation yielding WorkerTransportResource
 *
 * @example
 * ```typescript
 * const workerResource = yield* WorkerPrincipal({
 *   workerUrl: "./worker.js",
 *   initData: { toolName: "greet", params: {}, sessionId: "123" },
 * });
 * const principal = yield* initTransport(workerResource.middleware);
 *
 * // Send request
 * const response = yield* principal.request({ kind: "sample", type: "sample", payload: {...} });
 *
 * // Get final result
 * const result = yield* workerResource.result();
 * ```
 */
export function* WorkerPrincipal<T = unknown>(
  options: WorkerOptions
): Operation<WorkerTransportResource<T>> {
  const { workerUrl, initData } = options;

  return yield* resource<WorkerTransportResource<T>>(function* (provide) {
    // Create the worker using @effectionx/worker
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

    // Correlation state
    const pendingRequests = new Map<string, PendingRequest>();

    // Request ID counter
    let requestIdCounter = 0;

    /**
     * Generate a unique request ID.
     */
    function generateWorkerRequestId(): string {
      return `host:req:${++requestIdCounter}`;
    }

    // Spawn correlation router
    yield* spawn(function* () {
      for (const msg of yield* each(incomingChannel as Stream<PrincipalIncoming, void>)) {
        if (isResponseMessage(msg)) {
          const responseMsg = msg as ResponseMessage;
          const pending = pendingRequests.get(responseMsg.id);
          if (pending) {
            pendingRequests.delete(responseMsg.id);
            yield* pending.channel.close(responseMsg.response as ResponseByKind[RequestKind]);
          }
        }
        yield* each.next();
      }
    });

    // Create middleware Operation
    function* middleware(): Operation<TransportMiddleware> {
      return {
        *send([message], _next) {
          const outgoing = message as PrincipalOutgoing;

          // Convert to WorkerRequest and send to worker
          const workerRequest: WorkerRequest = toWorkerRequest(
            outgoing.id || generateWorkerRequestId(),
            outgoing
          );

          // Spawn a task to send request and route response to channel
          yield* spawn(function* () {
            try {
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
                } as never,
              };
              yield* incomingChannel.send(errorResponse);
            }
          });
        },

        *request([req], _next) {
          const typedReq = req as TransportRequestWithoutId;
          const id = generateRequestId();
          const fullReq: PrincipalOutgoing = { ...typedReq, id } as PrincipalOutgoing;

          const responseChannel = createChannel<never, ResponseByKind[RequestKind]>();
          pendingRequests.set(id, { channel: responseChannel });

          try {
            // Convert to WorkerRequest and send
            const workerRequest: WorkerRequest = toWorkerRequest(id, fullReq);

            // Send to worker and await response
            yield* spawn(function* () {
              try {
                const workerResponse: WorkerResponse = yield* worker.send(workerRequest);
                const responseMessage: PrincipalIncoming = {
                  type: "response",
                  id: workerResponse.id,
                  kind: workerResponse.type as RequestKind,
                  response: toResponsePayload(workerResponse),
                };
                yield* incomingChannel.send(responseMessage);
              } catch (error) {
                const errorResponse: PrincipalIncoming = {
                  type: "response",
                  id: id,
                  kind: typedReq.kind as RequestKind,
                  response: {
                    status: "error",
                    error: error instanceof Error ? error.message : String(error),
                  } as never,
                };
                yield* incomingChannel.send(errorResponse);
              }
            });

            // Wait for response via correlation
            const sub: Subscription<never, ResponseByKind[RequestKind]> = yield* responseChannel;
            let result = yield* sub.next();
            while (!result.done) {
              result = yield* sub.next();
            }
            return result.value;
          } finally {
            pendingRequests.delete(id);
          }
        },

        *stream() {
          return incomingChannel as Stream<PrincipalIncoming | OperativeIncoming, void>;
        },
      };
    }

    yield* provide({
      middleware: {
        *[Symbol.iterator]() {
          return yield* middleware();
        },
      },
      *result() {
        return yield* worker;
      },
    });
  });
}

// =============================================================================
// WORKER OPERATIVE
// =============================================================================

/**
 * Create a Worker operative resource (host handles requests from worker).
 *
 * In this configuration:
 * - Worker acts as principal (sends sample/elicit requests)
 * - Host acts as operative (handles requests via transport interface)
 *
 * @param options - Worker configuration
 * @returns Operation yielding WorkerTransportResource
 *
 * @example
 * ```typescript
 * const workerResource = yield* WorkerOperative({
 *   workerUrl: "./tool-worker.js",
 *   initData: { toolName: "greet", params: { name: "Alice" }, sessionId: "123" },
 * });
 * const operative = yield* initTransport(workerResource.middleware);
 *
 * // Handle requests from worker
 * for (const req of yield* each(yield* operative.stream())) {
 *   yield* operative.send({
 *     type: "response",
 *     id: req.id,
 *     kind: req.kind,
 *     response: { status: "accepted", content: {...} },
 *   });
 *   yield* each.next();
 * }
 *
 * // Get final result when worker completes
 * const result = yield* workerResource.result();
 * ```
 */
export function* WorkerOperative<T = unknown>(
  options: WorkerOptions
): Operation<WorkerTransportResource<T>> {
  const { workerUrl, initData } = options;

  return yield* resource<WorkerTransportResource<T>>(function* (provide) {
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
              kind: workerRequest.type as RequestKind,
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

    // Create middleware Operation
    function* middleware(): Operation<TransportMiddleware> {
      return {
        *send([message], _next) {
          const outgoing = message as OperativeOutgoing;

          if (isProgressMessage(outgoing)) {
            // Route progress to ctx.progress()
            const pending = pendingRequests.get(outgoing.id);
            if (pending) {
              const messageStr = typeof outgoing.data === "string"
                ? outgoing.data
                : (outgoing.data as { message?: string })?.message ?? "";
              const progressValue = (outgoing.data as { progress?: number })?.progress;

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
          } else if (isResponseMessage(outgoing)) {
            // Route response to responseChannel to unblock forEach callback
            const pending = pendingRequests.get(outgoing.id);
            if (pending) {
              yield* pending.responseChannel.send(outgoing);
            }
          }
        },

        *stream() {
          return incomingChannel as Stream<PrincipalIncoming | OperativeIncoming, void>;
        },
      };
    }

    yield* provide({
      middleware: {
        *[Symbol.iterator]() {
          return yield* middleware();
        },
      },
      *result() {
        return yield* worker;
      },
    });
  });
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert PrincipalOutgoing to WorkerRequest.
 */
function toWorkerRequest(id: string, outgoing: PrincipalOutgoing): WorkerRequest {
  // PrincipalOutgoing is TransportRequest<RequestKind>
  const payload = outgoing.payload as Record<string, unknown>;
  return {
    id,
    type: outgoing.kind,
    ...payload,
  } as WorkerRequest;
}

/**
 * Convert WorkerResponse to the payload format expected by ResponseByKind.
 */
function toResponsePayload(response: WorkerResponse): ResponseByKind[RequestKind] {
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
    };
  }

  if (response.type === "elicit") {
    if (response.status === "accepted") {
      return {
        status: "accepted",
        content: response.content,
      };
    } else if (response.status === "declined") {
      return { status: "declined" };
    } else {
      return { status: "cancelled" };
    }
  }

  // Fallback - shouldn't happen with proper typing
  return { status: "cancelled" };
}

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
