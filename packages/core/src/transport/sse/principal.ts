import {
  resource,
  createChannel,
  spawn,
  call,
  until,
  type Operation,
  type Subscription,
  type Channel,
} from "effection";
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

interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SSEPrincipalOptions {
  /** URL to receive SSE events from (progress/responses) */
  sseUrl: string;
  /** URL to POST requests to */
  postUrl: string;
  /** Custom fetch function for testing */
  fetch?: typeof fetch;
}

/**
 * Creates a PrincipalTransport that communicates over SSE + HTTP POST.
 *
 * - Sends requests via HTTP POST to `postUrl`
 * - Receives progress/responses via SSE from `sseUrl`
 *
 * @param options - Configuration options
 * @returns A PrincipalTransport
 */
export function* createSSEPrincipal(
  options: SSEPrincipalOptions
): Operation<PrincipalTransport> {
  const fetchFn = options.fetch ?? fetch;

  return yield* resource(function* (provide) {
    const incomingChannel: Channel<PrincipalIncoming, void> =
      createChannel<PrincipalIncoming, void>();

    // Spawn a task to read SSE events
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

    // Get the subscription from the channel
    const subscription: Subscription<PrincipalIncoming, void> =
      yield* incomingChannel;

    const transport: PrincipalTransport = {
      *[Symbol.iterator]() {
        return subscription;
      },

      *send(message: PrincipalOutgoing): Operation<void> {
        yield* until(
          fetchFn(options.postUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(message),
          })
        );
      },
    };

    yield* provide(transport);
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
