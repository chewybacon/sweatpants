/**
 * SSE+POST Frontend Transport
 *
 * The frontend side of the SSE+POST transport implementation.
 *
 * Communication flow:
 * - Frontend receives messages via SSE (Server-Sent Events)
 * - Frontend responds via HTTP POST
 * - Progress events are sent from frontend to backend via the same POST endpoint
 *
 * This transport is designed for browser environments.
 */

import {
  resource,
  call,
  ensure,
  type Operation,
  type Stream,
} from "effection";
import type {
  FrontendTransport,
  IncomingMessage,
  ElicitResponse,
  NotifyResponse,
} from "../../types/transport.ts";

/**
 * SSE event from the server.
 */
interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Options for creating an SSE frontend transport.
 */
export interface SSEFrontendTransportOptions {
  /**
   * URL to connect to for SSE events.
   */
  sseUrl: string;

  /**
   * URL to POST responses to.
   */
  responseUrl: string;

  /**
   * Optional fetch function for making HTTP requests.
   * Defaults to global fetch.
   */
  fetch?: typeof fetch;
}

/**
 * Creates a frontend transport that uses SSE for receiving messages
 * and POST for sending responses.
 *
 * Usage:
 * ```ts
 * const transport = yield* createSSEFrontendTransport({
 *   sseUrl: '/api/events',
 *   responseUrl: '/api/respond',
 * });
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
export function* createSSEFrontendTransport(
  options: SSEFrontendTransportOptions
): Operation<FrontendTransport> {
  const fetchFn = options.fetch ?? fetch;

  const messages: Stream<IncomingMessage, void> = resource(function* (
    provide
  ) {
    // Open SSE connection
    const response = yield* call(() =>
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

    // Ensure cleanup on exit
    yield* ensure(function* () {
      yield* call(() => reader.cancel());
    });

    yield* provide({
      *next(): Operation<IteratorResult<IncomingMessage, void>> {
        while (true) {
          // Try to extract a complete event from buffer
          const eventEndIndex = buffer.indexOf("\n\n");

          if (eventEndIndex !== -1) {
            const eventBlock = buffer.slice(0, eventEndIndex);
            buffer = buffer.slice(eventEndIndex + 2);

            const event = parseEventBlock(eventBlock);
            if (event && event.data) {
              // Parse the message
              const rawMessage = JSON.parse(event.data);

              // Create IncomingMessage with progress/respond methods
              const message: IncomingMessage = {
                id: rawMessage.id,
                kind: rawMessage.kind,
                type: rawMessage.type,
                payload: rawMessage.payload,

                *progress(data: unknown): Operation<void> {
                  yield* call(() =>
                    fetchFn(options.responseUrl, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        type: "progress",
                        id: rawMessage.id,
                        data,
                      }),
                    })
                  );
                },

                *respond(
                  response: ElicitResponse | NotifyResponse
                ): Operation<void> {
                  yield* call(() =>
                    fetchFn(options.responseUrl, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        type: "response",
                        id: rawMessage.id,
                        response,
                      }),
                    })
                  );
                },
              };

              return { done: false, value: message };
            }
            continue;
          }

          // Need more data from the reader
          const { done, value } = yield* call(() => reader.read());

          if (done) {
            // Connection closed
            return { done: true, value: undefined };
          }

          buffer += decoder.decode(value, { stream: true });
        }
      },
    });
  });

  return { messages };
}

/**
 * Parse an SSE event block into a structured event.
 */
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
