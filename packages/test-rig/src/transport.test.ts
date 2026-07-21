import { describe, expect, it } from "vitest";
import { createStreamTransportHandle } from "./transport.ts";

function response(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "x-session-id": "stream-session", "content-type": "application/x-ndjson" },
  });
}

const encode = (value: string) => new TextEncoder().encode(value);

describe("stream transport checkpoints", () => {
  it("checkpoints only through consumed frames from a multi-frame chunk", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encode(
            `${JSON.stringify({ lsn: 1, event: { type: "FIRST" } })}\n` +
              `${JSON.stringify({ lsn: 2, event: { type: "SECOND" } })}\n`,
          ),
        );
        controller.close();
      },
    });
    const transport = createStreamTransportHandle(async () => response(body), 100);
    const stream = await transport.openTurn({ conversationId: "test", message: "test" });

    await stream.expectEvent("FIRST");
    expect(stream.checkpoint()).toEqual({ sessionId: "stream-session", offset: 1 });
    await stream.expectEvent("SECOND");
    expect(stream.checkpoint()).toEqual({ sessionId: "stream-session", offset: 2 });
  });

  it("can retry after a timed-out event wait without concurrent reader reads", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    const transport = createStreamTransportHandle(async () => response(body), 20);
    const stream = await transport.openTurn({ conversationId: "test", message: "test" });

    await expect(stream.expectEvent("LATE")).rejects.toThrow(/barrier_timeout/);
    controller.enqueue(encode(`${JSON.stringify({ lsn: 3, event: { type: "LATE" } })}\n`));
    expect(await stream.expectEvent("LATE")).toMatchObject({ lsn: 3 });
    await stream.disconnect();
  });
});
