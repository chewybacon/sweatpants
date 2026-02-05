/**
 * SSE Transport Middleware
 *
 * Server-Sent Events (SSE) + HTTP POST transport middleware.
 * - Receives messages via SSE
 * - Sends messages via HTTP POST
 *
 * ## Usage
 *
 * ```typescript
 * // Principal side
 * const principal = yield* initTransport(SSEPrincipal({
 *   sseUrl: "https://api.example.com/events",
 *   postUrl: "https://api.example.com/requests",
 * }));
 *
 * // Operative side
 * const operative = yield* initTransport(SSEOperative({
 *   sseUrl: "https://api.example.com/requests",
 *   responseUrl: "https://api.example.com/responses",
 * }));
 * ```
 *
 * @packageDocumentation
 */

import {
  createChannel,
  spawn,
  each,
  call,
  until,
  type Operation,
  type Channel,
  type Stream,
  type Subscription,
} from "effection";
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

interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Options for SSE principal transport.
 */
export interface SSEPrincipalOptions {
  /** URL to receive SSE events from (progress/responses) */
  sseUrl: string;
  /** URL to POST requests to */
  postUrl: string;
  /** Custom fetch function for testing */
  fetch?: typeof fetch;
}

/**
 * Options for SSE operative transport.
 */
export interface SSEOperativeOptions {
  /** URL to receive SSE events from (requests) */
  sseUrl: string;
  /** URL to POST responses to */
  responseUrl: string;
  /** Custom fetch function for testing */
  fetch?: typeof fetch;
}

/**
 * Pending request waiting for response.
 */
interface PendingRequest {
  channel: Channel<never, ResponseByKind[RequestKind]>;
}

// =============================================================================
// SSE PRINCIPAL
// =============================================================================

/**
 * Create an SSE principal middleware.
 *
 * - Receives progress/responses via SSE from `sseUrl`
 * - Sends requests via HTTP POST to `postUrl`
 *
 * @param options - SSE connection options
 * @returns Operation that yields PrincipalMiddleware
 */
export function SSEPrincipal(options: SSEPrincipalOptions): Operation<TransportMiddleware> {
  const fetchFn = options.fetch ?? fetch;

  return {
    *[Symbol.iterator]() {
      const incomingChannel: Channel<PrincipalIncoming, void> =
        createChannel<PrincipalIncoming, void>();

      // Correlation state
      const pendingRequests = new Map<string, PendingRequest>();

      // Spawn task to read SSE events
      yield* spawn(function* () {
        const response = yield* until(
          fetchFn(options.sseUrl, {
            headers: {
              Accept: "text/event-stream",
              "Cache-Control": "no-cache",
            },
          })
        );

        if (!response.ok) {
          throw new Error(
            `SSE connection failed: ${response.status} ${response.statusText}`
          );
        }

        if (!response.body) {
          throw new Error("SSE response has no body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = yield* until(reader.read());

            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Process complete events
            let eventEndIndex;
            while ((eventEndIndex = buffer.indexOf("\n\n")) !== -1) {
              const eventBlock = buffer.slice(0, eventEndIndex);
              buffer = buffer.slice(eventEndIndex + 2);

              const event = parseEventBlock(eventBlock);
              if (event && event.data) {
                try {
                  const raw = JSON.parse(event.data);

                  // Try parsing as progress message
                  const progressResult = ProgressMessageSchema.safeParse(raw);
                  if (progressResult.success) {
                    yield* incomingChannel.send(
                      progressResult.data as ProgressMessage
                    );
                    continue;
                  }

                  // Try parsing as response message
                  const responseResult = ResponseMessageSchema.safeParse(raw);
                  if (responseResult.success) {
                    yield* incomingChannel.send(
                      responseResult.data as ResponseMessage
                    );
                  }
                } catch {
                  // Ignore malformed JSON
                }
              }
            }
          }
        } finally {
          yield* call(() => reader.cancel());
        }

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
          yield* until(
            fetchFn(options.postUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(message),
            })
          );
        },

        *request([req], _next) {
          const id = generateRequestId();
          const fullReq: PrincipalOutgoing = { ...req, id } as PrincipalOutgoing;

          const responseChannel = createChannel<never, ResponseByKind[RequestKind]>();
          pendingRequests.set(id, { channel: responseChannel });

          try {
            // Send via HTTP POST
            yield* until(
              fetchFn(options.postUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(fullReq),
              })
            );

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
// SSE OPERATIVE
// =============================================================================

/**
 * Create an SSE operative middleware.
 *
 * - Receives requests via SSE from `sseUrl`
 * - Sends progress/responses via HTTP POST to `responseUrl`
 *
 * @param options - SSE connection options
 * @returns Operation that yields OperativeMiddleware
 */
export function SSEOperative(options: SSEOperativeOptions): Operation<TransportMiddleware> {
  const fetchFn = options.fetch ?? fetch;

  return {
    *[Symbol.iterator]() {
      const incomingChannel: Channel<OperativeIncoming, void> =
        createChannel<OperativeIncoming, void>();

      // Spawn task to read SSE events
      yield* spawn(function* () {
        const response = yield* until(
          fetchFn(options.sseUrl, {
            headers: {
              Accept: "text/event-stream",
              "Cache-Control": "no-cache",
            },
          })
        );

        if (!response.ok) {
          throw new Error(
            `SSE connection failed: ${response.status} ${response.statusText}`
          );
        }

        if (!response.body) {
          throw new Error("SSE response has no body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = yield* until(reader.read());

            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });

            // Process complete events
            let eventEndIndex;
            while ((eventEndIndex = buffer.indexOf("\n\n")) !== -1) {
              const eventBlock = buffer.slice(0, eventEndIndex);
              buffer = buffer.slice(eventEndIndex + 2);

              const event = parseEventBlock(eventBlock);
              if (event && event.data) {
                try {
                  const raw = JSON.parse(event.data);
                  const parsed = TransportRequestSchema.safeParse(raw);
                  if (parsed.success) {
                    yield* incomingChannel.send(parsed.data);
                  }
                } catch {
                  // Ignore malformed JSON
                }
              }
            }
          }
        } finally {
          yield* call(() => reader.cancel());
        }

        yield* incomingChannel.close();
      });

      // Return the middleware decoration object
      return {
        *send([message], _next) {
          yield* until(
            fetchFn(options.responseUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(message),
            })
          );
        },

        *stream(_args, _next) {
          return incomingChannel as Stream<PrincipalIncoming | OperativeIncoming, void>;
        },
      };
    },
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function parseEventBlock(block: string): SSEEvent | null {
  const event: SSEEvent = { data: "" };
  const lines = block.split("\n");

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      event.data += line.slice(5).trim();
    } else if (line.startsWith("id:")) {
      event.id = line.slice(3).trim();
    } else if (line.startsWith("retry:")) {
      event.retry = parseInt(line.slice(6).trim(), 10);
    }
  }

  return event.data ? event : null;
}
