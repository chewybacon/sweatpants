import {
  resource,
  call,
  until,
  type Operation,
  type Subscription,
} from "effection";
import type {
  OperativeTransport,
  OperativeIncoming,
  OperativeOutgoing,
} from "../../types/transport.ts";
import { TransportRequestSchema } from "../../types/schemas.ts";

interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SSEOperativeOptions {
  /** URL to receive SSE events from (requests) */
  sseUrl: string;
  /** URL to POST responses to */
  responseUrl: string;
  /** Custom fetch function for testing */
  fetch?: typeof fetch;
}

/**
 * Creates an OperativeTransport that communicates over SSE + HTTP POST.
 *
 * - Receives requests via SSE from `sseUrl`
 * - Sends progress/responses via HTTP POST to `responseUrl`
 *
 * @param options - Configuration options
 * @returns An OperativeTransport
 */
export function* createSSEOperative(
  options: SSEOperativeOptions
): Operation<OperativeTransport> {
  const fetchFn = options.fetch ?? fetch;

  return yield* resource(function* (provide) {
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

    // Create subscription that reads from SSE
    const subscription: Subscription<OperativeIncoming, void> = {
      *next(): Operation<IteratorResult<OperativeIncoming, void>> {
        while (true) {
          // Check if we have a complete event in the buffer
          const eventEndIndex = buffer.indexOf("\n\n");

          if (eventEndIndex !== -1) {
            const eventBlock = buffer.slice(0, eventEndIndex);
            buffer = buffer.slice(eventEndIndex + 2);

            const event = parseEventBlock(eventBlock);
            if (event && event.data) {
              try {
                const raw = JSON.parse(event.data);
                const parsed = TransportRequestSchema.safeParse(raw);
                if (parsed.success) {
                  return { done: false, value: parsed.data };
                }
              } catch {
                // Ignore malformed JSON, continue reading
              }
            }
            continue;
          }

          // Read more data from SSE
          const { done, value } = yield* until(reader.read());

          if (done) {
            return { done: true, value: undefined };
          }

          buffer += decoder.decode(value, { stream: true });
        }
      },
    };

    const transport: OperativeTransport = {
      *[Symbol.iterator]() {
        return subscription;
      },

      *send(message: OperativeOutgoing): Operation<void> {
        yield* until(
          fetchFn(options.responseUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
          })
        );
      },
    };

    try {
      yield* provide(transport);
    } finally {
      yield* call(() => reader.cancel());
    }
  });
}

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
