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
  PrincipalTransport,
  PrincipalOutgoing,
  PrincipalIncoming,
  ProgressMessage,
  ResponseMessage,
} from "../../types/transport.ts";
import {
  ProgressMessageSchema,
  ResponseMessageSchema,
} from "../../types/schemas.ts";

/**
 * Wire message types for WebSocket transport.
 */
export type WebSocketWireMessage =
  | { type: "request"; payload: PrincipalOutgoing }
  | ProgressMessage
  | ResponseMessage;

/**
 * Creates a PrincipalTransport that communicates over WebSocket.
 *
 * @param url - The WebSocket server URL to connect to
 * @returns A PrincipalTransport that sends requests and receives progress/responses
 */
export function* createWebSocketPrincipal(
  url: string
): Operation<PrincipalTransport> {
  return yield* resource(function* (provide) {
    const socket: WebSocketResource<string> = yield* useWebSocket(url);
    const incomingChannel: Channel<PrincipalIncoming, void> =
      createChannel<PrincipalIncoming, void>();

    // Spawn a task to route incoming messages to the channel
    yield* spawn(function* () {
      const socketSub = yield* socket;
      let result = yield* socketSub.next();

      while (!result.done) {
        const event = result.value;
        try {
          const raw = JSON.parse(event.data);

          // Validate and route progress messages
          const progressResult = ProgressMessageSchema.safeParse(raw);
          if (progressResult.success) {
            yield* incomingChannel.send(progressResult.data as ProgressMessage);
          }

          // Validate and route response messages
          const responseResult = ResponseMessageSchema.safeParse(raw);
          if (responseResult.success) {
            yield* incomingChannel.send(responseResult.data as ResponseMessage);
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
    const subscription: Subscription<PrincipalIncoming, void> =
      yield* incomingChannel;

    const transport: PrincipalTransport = {
      *[Symbol.iterator]() {
        return subscription;
      },

      *send(message: PrincipalOutgoing): Operation<void> {
        const wireMessage: WebSocketWireMessage = {
          type: "request",
          payload: message,
        };
        socket.send(JSON.stringify(wireMessage));
      },
    };

    yield* provide(transport);
  });
}
