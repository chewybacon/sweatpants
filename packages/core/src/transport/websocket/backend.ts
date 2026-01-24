/**
 * WebSocket Backend Transport
 *
 * The backend side of the WebSocket transport implementation.
 *
 * Communication flow:
 * - Backend sends messages via WebSocket
 * - Frontend responds via WebSocket
 * - Progress events also flow via WebSocket
 *
 * This transport is designed for real-time bidirectional communication.
 */

import {
  resource,
  createChannel,
  each,
  spawn,
  type Operation,
  type Stream,
  type Subscription,
  type Channel,
} from "effection";
import {
  useWebSocket,
  type WebSocketResource,
} from "@effectionx/websocket";
import type {
  BackendTransport,
  TransportRequest,
  ElicitResponse,
  NotifyResponse,
} from "../../types/transport.ts";

/**
 * Wire protocol for WebSocket messages
 */
export type WebSocketMessage =
  | { type: "request"; payload: TransportRequest }
  | { type: "progress"; id: string; data: unknown }
  | { type: "response"; id: string; response: ElicitResponse | NotifyResponse };

/**
 * A pending request waiting for a response from the frontend.
 */
interface PendingRequest {
  id: string;
  channel: Channel<unknown, unknown>;
}

/**
 * Creates a backend transport that uses WebSocket for bidirectional communication.
 *
 * Usage:
 * ```ts
 * const transport = yield* createWebSocketBackendTransport('ws://localhost:3000/chat');
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
export function* createWebSocketBackendTransport(
  url: string
): Operation<WebSocketBackendTransport> {
  const socket: WebSocketResource<string> = yield* useWebSocket(url);
  const pending = new Map<string, PendingRequest>();

  // Spawn a listener for incoming messages (progress/response from frontend)
  yield* spawn(function* () {
    for (const event of yield* each(socket)) {
      try {
        const message: WebSocketMessage = JSON.parse(event.data);

        if (message.type === "progress") {
          const request = pending.get(message.id);
          if (request) {
            yield* request.channel.send(message.data);
          }
        } else if (message.type === "response") {
          const request = pending.get(message.id);
          if (request) {
            yield* request.channel.close(message.response);
            pending.delete(message.id);
          }
        }
      } catch {
        // Ignore malformed messages
      }
      yield* each.next();
    }
  });

  const transport: WebSocketBackendTransport = {
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
          // Send the message to the frontend via WebSocket
          const wireMessage: WebSocketMessage = {
            type: "request",
            payload: message,
          };
          socket.send(JSON.stringify(wireMessage));

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
  };

  return transport;
}

/**
 * WebSocket backend transport.
 * 
 * Unlike SSE transport, WebSocket doesn't need explicit receive methods
 * since responses come through the socket's message stream automatically.
 */
export interface WebSocketBackendTransport extends BackendTransport {
  // No additional methods needed - responses come through the WebSocket
}
