/**
 * WebSocket Transport Middleware
 *
 * WebSocket-based transport middleware for principal and operative sides.
 *
 * ## Usage
 *
 * ```typescript
 * // Principal side
 * yield* TransportApi.decorate(yield* WebSocketPrincipal({ url: "wss://..." }));
 * const { send, request, stream } = yield* usePrincipal();
 *
 * // Operative side
 * yield* TransportApi.decorate(yield* WebSocketOperative({ url: "wss://..." }));
 * const { send, stream } = yield* useOperative();
 * ```
 *
 * @packageDocumentation
 */

import {
  createChannel,
  spawn,
  each,
  type Operation,
  type Channel,
  type Stream,
  type Subscription,
} from "effection";
import { useWebSocket, type WebSocketResource } from "@effectionx/websocket";
import type {
  PrincipalOutgoing,
  PrincipalIncoming,
  OperativeIncoming,
  ProgressMessage,
  ResponseMessage,
  RequestKind,
  ResponseByKind,
} from "../../types/transport.ts";
import { isResponseMessage } from "../../types/transport.ts";
import {
  ProgressMessageSchema,
  ResponseMessageSchema,
  TransportRequestSchema,
} from "../../types/schemas.ts";
import {
  generateRequestId,
  type TransportMiddleware,
} from "../api.ts";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for WebSocket transport.
 */
export interface WebSocketOptions {
  url: string;
}

/**
 * Wire message types for WebSocket transport.
 */
export type WebSocketWireMessage =
  | { type: "request"; payload: PrincipalOutgoing }
  | ProgressMessage
  | ResponseMessage;

/**
 * Pending request waiting for response.
 */
interface PendingRequest {
  channel: Channel<never, ResponseByKind[RequestKind]>;
}

// =============================================================================
// WEBSOCKET PRINCIPAL
// =============================================================================

/**
 * Create a WebSocket principal middleware.
 *
 * Sets up WebSocket connection, message routing, and request/response correlation.
 *
 * @param options - WebSocket connection options
 * @returns Operation that yields TransportMiddleware
 *
 * @example
 * ```typescript
 * yield* TransportApi.decorate(yield* WebSocketPrincipal({ url: "wss://api.example.com" }));
 * const { request } = yield* usePrincipal();
 * const response = yield* request({ kind: "elicit", type: "confirm", payload: {} });
 * ```
 */
export function WebSocketPrincipal(options: WebSocketOptions): Operation<TransportMiddleware> {
  return {
    *[Symbol.iterator]() {
      const socket: WebSocketResource<string> = yield* useWebSocket(options.url);
      const incomingChannel: Channel<PrincipalIncoming, void> =
        createChannel<PrincipalIncoming, void>();

      // Correlation state
      const pendingRequests = new Map<string, PendingRequest>();

      // Spawn task to route incoming WebSocket messages to channel
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

      // Return the middleware decoration object
      return {
        *send([message], _next) {
          const wireMessage: WebSocketWireMessage = {
            type: "request",
            payload: message as PrincipalOutgoing,
          };
          socket.send(JSON.stringify(wireMessage));
        },

        *request([req], _next) {
          const id = generateRequestId();
          const fullReq: PrincipalOutgoing = { ...req, id } as PrincipalOutgoing;

          const responseChannel = createChannel<never, ResponseByKind[RequestKind]>();
          pendingRequests.set(id, { channel: responseChannel });

          try {
            // Send via WebSocket
            const wireMessage: WebSocketWireMessage = {
              type: "request",
              payload: fullReq,
            };
            socket.send(JSON.stringify(wireMessage));

            // Wait for response
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

        *stream(_args, _next) {
          return incomingChannel as Stream<PrincipalIncoming | OperativeIncoming, void>;
        },
      };
    },
  };
}

// =============================================================================
// WEBSOCKET OPERATIVE
// =============================================================================

/**
 * Create a WebSocket operative middleware.
 *
 * Sets up WebSocket connection and message routing.
 *
 * @param options - WebSocket connection options
 * @returns Operation that yields TransportMiddleware
 *
 * @example
 * ```typescript
 * yield* TransportApi.decorate(yield* WebSocketOperative({ url: "wss://api.example.com" }));
 * const { send, stream } = yield* useOperative();
 * for (const req of yield* each(yield* stream())) {
 *   yield* send({ type: "response", id: req.id, kind: req.kind, response: {...} });
 *   yield* each.next();
 * }
 * ```
 */
export function WebSocketOperative(options: WebSocketOptions): Operation<TransportMiddleware> {
  return {
    *[Symbol.iterator]() {
      const socket: WebSocketResource<string> = yield* useWebSocket(options.url);
      const incomingChannel: Channel<OperativeIncoming, void> =
        createChannel<OperativeIncoming, void>();

      // Spawn task to route incoming WebSocket messages to channel
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

      // Return the middleware decoration object
      return {
        *send([message], _next) {
          // Progress and Response messages are already in wire format
          socket.send(JSON.stringify(message));
        },

        *stream(_args, _next) {
          return incomingChannel as Stream<PrincipalIncoming | OperativeIncoming, void>;
        },
      };
    },
  };
}
