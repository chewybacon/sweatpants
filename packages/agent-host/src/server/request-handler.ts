import type { ChatApp } from "./index.ts";

type RequestApp = Pick<ChatApp, "handler" | "close">;

/**
 * Own one application per HTTP request (for Workers and other request-scoped hosts).
 * The response consumer owns its lifetime: EOF, cancellation, or read failure closes
 * the application. Reads remain demand-driven; this wrapper never prefetches.
 */
export function createChatFetchHandler(
  createApp: (request: Request) => RequestApp | Promise<RequestApp>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const app = await createApp(request);
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= Promise.resolve().then(() => app.close()));
    let response: Response;
    try {
      response = await app.handler(request);
    } catch (error) {
      await close();
      throw error;
    }
    if (!response.body) {
      await close();
      return response;
    }
    const reader = response.body.getReader();
    return new Response(
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
              next = await reader.read();
            } catch (error) {
              try {
                await close();
              } catch (closeError) {
                controller.error(
                  new AggregateError([error, closeError], "Chat response and cleanup failed"),
                );
                return;
              }
              controller.error(error);
              return;
            }
            if (next.done) {
              try {
                await close();
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            } else {
              controller.enqueue(next.value);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              await close();
            }
          },
        },
        { highWaterMark: 0 },
      ),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}
