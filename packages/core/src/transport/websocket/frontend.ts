/**
 * WebSocket Frontend Transport
 *
 * The frontend side of the WebSocket transport implementation.
 *
 * Communication flow:
 * - Frontend receives messages via WebSocket
 * - Frontend responds via WebSocket
 * - Progress events are sent via WebSocket
 *
 * This transport is designed for browser environments with real-time
 * bidirectional communication.
 */

import {
  resource,
  createChannel,
  each,
  spawn,
  type Operation,
  type Stream,
  type Channel,
} from "effection";
import { useWebSocket, type WebSocketResource } from "@effectionx/websocket";
import type {
  FrontendTransport,
  IncomingMessage,
  ElicitResponse,
  NotifyResponse,
} from "../../types/transport.ts";
import type { WebSocketMessage } from "./backend.ts";

/**
 * Creates a frontend transport that uses WebSocket for bidirectional communication.
 *
 * Usage:
 * ```ts
 * const transport = yield* createWebSocketFrontendTransport('ws://localhost:3000/chat');
 *
 * for (const message of yield* each(transport.messages)) {
 *   if (message.kind === 'elicit' && message.type === 'location') {
 *     yield* message.progress({ status: 'acquiring' });
 *     const position = yield* getLocation();
 *     yield* message.respond({
 *       status: 'accepted',
 *       content: { lat: position.lat, lng: position.lng }
 *     });
 *   }
 *   yield* each.next();
 * }
 * ```
 */
export function* createWebSocketFrontendTransport(
  url: string
): Operation<FrontendTransport> {
  const socket: WebSocketResource<string> = yield* useWebSocket(url);
  const messageChannel: Channel<IncomingMessage, void> = createChannel<
    IncomingMessage,
    void
  >();

  // Spawn a listener for incoming requests from backend
  yield* spawn(function* () {
    for (const event of yield* each(socket)) {
      try {
        const wireMessage: WebSocketMessage = JSON.parse(event.data);

        if (wireMessage.type === "request") {
          const request = wireMessage.payload;

          const message: IncomingMessage = {
            id: request.id,
            kind: request.kind,
            type: request.type,
            payload: request.payload,

            // These send back to the backend via WebSocket
            *progress(data: unknown): Operation<void> {
              const progressMessage: WebSocketMessage = {
                type: "progress",
                id: request.id,
                data,
              };
              socket.send(JSON.stringify(progressMessage));
            },

            *respond(
              response: ElicitResponse | NotifyResponse
            ): Operation<void> {
              const responseMessage: WebSocketMessage = {
                type: "response",
                id: request.id,
                response,
              };
              socket.send(JSON.stringify(responseMessage));
            },
          };

          yield* messageChannel.send(message);
        }
      } catch {
        // Ignore malformed messages
      }
      yield* each.next();
    }

    // Close the message channel when the socket closes
    yield* messageChannel.close();
  });

  // Return transport with messages stream
  const messages: Stream<IncomingMessage, void> = resource(function* (
    provide
  ) {
    const subscription = yield* messageChannel;
    yield* provide(subscription);
  });

  return { messages };
}
