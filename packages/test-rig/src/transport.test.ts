import { describe, expect, it } from "vitest";
import { createStreamTransportHandle } from "./transport.ts";

function response(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

const encode = (value: string) => new TextEncoder().encode(value);
const started = () => JSON.stringify({ type: "RUN_STARTED", threadId: "test", runId: "run" });

describe("stream transport checkpoints", () => {
  it("checkpoints only the latest opaque window basis, never a response offset", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encode(
            `${started()}\n` +
              `${JSON.stringify({
                type: "sweatpants.conversation-window.v1",
                conversationId: "test",
                lineageId: "lineage:test",
                basisRevision: "1",
                windowToken: "opaque-window-token",
                windowMode: "reset",
                archiveFrontierOrdinal: "0",
                nextPublicPosition: "0",
                hotRoots: [],
                sealedCatchupRoots: [],
                applicationState: {},
                olderHistoryCursor: null,
              })}\n`,
          ),
        );
        controller.close();
      },
    });
    const transport = createStreamTransportHandle(async () => response(body), 100);
    const stream = await transport.openTurn({ conversationId: "test", message: "test" });

    await stream.expectEvent("RUN_STARTED");
    expect(stream.events).toHaveLength(1);
    await stream.expectEvent("sweatpants.conversation-window.v1");
    expect(stream.checkpoint()).toEqual({
      conversationId: "test",
      knownWindowToken: "opaque-window-token",
    });
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

    await expect(stream.expectEvent("RUN_STARTED")).rejects.toThrow(/barrier_timeout/);
    controller.enqueue(encode(`${started()}\n`));
    expect(await stream.expectEvent("RUN_STARTED")).toMatchObject({ sequence: 1 });
    await stream.disconnect();
  });
});
