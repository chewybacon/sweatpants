import {
  resource,
  createChannel,
  spawn,
  type Operation,
  type Subscription,
  type Channel,
} from "effection";
import { useWebSocket, type WebSocketResource } from "@effectionx/websocket";
import type {
  OperativeTransport,
  OperativeIncoming,
  OperativeOutgoing,
  ProgressMessage,
  ResponseMessage,
} from "../../types/transport.ts";
import { TransportRequestSchema } from "../../types/schemas.ts";
import type { WebSocketWireMessage } from "./principal.ts";

/**
 * Creates an OperativeTransport that communicates over WebSocket.
 *
 * @param url - The WebSocket server URL to connect to
 * @returns An OperativeTransport that receives requests and sends progress/responses
 */
export function* createWebSocketOperative(
  url: string
): Operation<OperativeTransport> {
  return yield* resource(function* (provide) {
    const socket: WebSocketResource<string> = yield* useWebSocket(url);
    const incomingChannel: Channel<OperativeIncoming, void> =
      createChannel<OperativeIncoming, void>();

    // Spawn a task to route incoming messages to the channel
    yield* spawn(function* () {
      const socketSub = yield* socket;
      let result = yield* socketSub.next();

      while (!result.done) {
        const event = result.value;
        try {
          const raw = JSON.parse(event.data);

          // Check if it's a request message
          if (raw.type === "request" && raw.payload) {
            const requestResult = TransportRequestSchema.safeParse(raw.payload);
            if (requestResult.success) {
              yield* incomingChannel.send(requestResult.data);
            }
          }
        } catch {
          // Ignore malformed messages
        }
        result = yield* socketSub.next();
      }

      // Socket closed, close the channel
      yield* incomingChannel.close();
    });

    // Get the subscription from the channel
    const subscription: Subscription<OperativeIncoming, void> =
      yield* incomingChannel;

    const transport: OperativeTransport = {
      *[Symbol.iterator]() {
        return subscription;
      },

      *send(message: OperativeOutgoing): Operation<void> {
        // Progress and Response messages are already in wire format
        const wireMessage: WebSocketWireMessage = message as
          | ProgressMessage
          | ResponseMessage;
        socket.send(JSON.stringify(wireMessage));
      },
    };

    yield* provide(transport);
  });
}
