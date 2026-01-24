/**
 * SSE+POST Backend Transport
 *
 * The backend side of the SSE+POST transport implementation.
 *
 * Communication flow:
 * - Backend sends messages via SSE (Server-Sent Events)
 * - Frontend responds via HTTP POST
 * - Progress events flow from frontend to backend via the same POST endpoint
 *
 * This transport is designed for traditional request-response HTTP infrastructure.
 */

import {
  resource,
  createChannel,
  type Operation,
  type Stream,
  type Subscription,
  type Channel,
} from "effection";
import type {
  BackendTransport,
  TransportRequest,
  ElicitResponse,
  NotifyResponse,
} from "../../types/transport.ts";

/**
 * A pending request waiting for a response from the frontend.
 */
interface PendingRequest {
  id: string;
  channel: Channel<unknown, unknown>;
}

/**
 * Options for creating an SSE backend transport.
 */
export interface SSEBackendTransportOptions {
  /**
   * Called when a message needs to be sent to the frontend.
   * This should write to the SSE response stream.
   */
  onSend: (message: TransportRequest) => Operation<void>;
}

/**
 * Creates a backend transport that uses SSE for outbound messages.
 *
 * Usage:
 * ```ts
 * const transport = yield* createSSEBackendTransport({
 *   onSend: function* (message) {
 *     yield* sseWriter.write(`data: ${JSON.stringify(message)}\n\n`);
 *   },
 * });
 *
 * // Send a message and consume progress
 * const stream = transport.send({
 *   id: 'msg-1',
 *   kind: 'elicit',
 *   type: 'location',
 *   payload: { accuracy: 'high' }
 * });
 *
 * for (const progress of yield* each(stream)) {
 *   console.log('Progress:', progress);
 *   yield* each.next();
 * }
 *
 * const response = yield* stream;
 * ```
 */
export function* createSSEBackendTransport(
  options: SSEBackendTransportOptions
): Operation<SSEBackendTransport> {
  const pending = new Map<string, PendingRequest>();

  const transport: SSEBackendTransport = {
    send<TPayload, TProgress, TResponse extends ElicitResponse | NotifyResponse>(
      message: TransportRequest<TPayload>
    ): Stream<TProgress, TResponse> {
      return resource(function* (provide) {
        // Create a channel to receive progress and response
        const channel = createChannel<TProgress, TResponse>();

        // Store the pending request
        pending.set(message.id, {
          id: message.id,
          channel: channel as Channel<unknown, unknown>,
        });

        try {
          // Send the message to the frontend via SSE
          yield* options.onSend(message);

          // Get subscription from the channel
          const subscription: Subscription<TProgress, TResponse> =
            yield* channel;

          // Provide the subscription to the caller
          yield* provide(subscription);
        } finally {
          // Clean up when the stream is closed
          pending.delete(message.id);
        }
      });
    },

    /**
     * Handle progress from the frontend.
     * Called when the frontend sends a progress update via POST.
     */
    *receiveProgress(id: string, data: unknown): Operation<void> {
      const request = pending.get(id);
      if (request) {
        yield* request.channel.send(data);
      }
    },

    /**
     * Handle the final response from the frontend.
     * Called when the frontend completes via POST.
     */
    *receiveResponse(
      id: string,
      response: ElicitResponse | NotifyResponse
    ): Operation<void> {
      const request = pending.get(id);
      if (request) {
        yield* request.channel.close(response);
        pending.delete(id);
      }
    },
  };

  return transport;
}

/**
 * Extended backend transport with methods to receive frontend responses.
 */
export interface SSEBackendTransport extends BackendTransport {
  /**
   * Handle progress from the frontend.
   * Called when the frontend sends a progress update via POST.
   *
   * This is an Operation because it uses channels internally.
   * Must be called from within an Effection context.
   */
  receiveProgress(id: string, data: unknown): Operation<void>;

  /**
   * Handle the final response from the frontend.
   * Called when the frontend completes via POST.
   *
   * This is an Operation because it uses channels internally.
   * Must be called from within an Effection context.
   */
  receiveResponse(
    id: string,
    response: ElicitResponse | NotifyResponse
  ): Operation<void>;
}
