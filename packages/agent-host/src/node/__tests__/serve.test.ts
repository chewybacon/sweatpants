// @vitest-environment node
import { IncomingMessage, ServerResponse, get } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { serve, toNodeHandler } from "../index.ts";

describe("Node HTTP transport", () => {
  it("pulls only on downstream demand and cancels a blocked stream on disconnect", async () => {
    let reads = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array([reads]));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const incoming = new IncomingMessage(new Socket());
    incoming.method = "GET";
    incoming.url = "/";
    incoming.headers.host = "localhost";
    const outgoing = new ServerResponse(incoming);
    // Hold the transport at the writable boundary; only an explicit drain grants demand.
    const write = vi.spyOn(outgoing, "write").mockReturnValue(false);
    const handler = toNodeHandler(() => new Response(body));
    expect(reads).toBe(0);
    const sending = handler(incoming, outgoing);
    try {
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(reads).toBe(1);
      outgoing.emit("drain");
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
      expect(reads).toBe(2);
      outgoing.emit("close");
      await sending;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(reads).toBe(2);
    } finally {
      outgoing.emit("close");
      incoming.destroy();
      write.mockRestore();
    }
  });

  it("serves request bodies and response headers and closes the application once", async () => {
    const close = vi.fn(async () => {});
    const server = await serve(
      {
        async handler(request) {
          return new Response(await request.text(), { status: 201, headers: { "x-test": "yes" } });
        },
        close,
      },
      { port: 0 },
    );
    try {
      const response = await fetch(server.origin, { method: "POST", body: "hello" });
      expect(response.status).toBe(201);
      expect(response.headers.get("x-test")).toBe("yes");
      expect(await response.text()).toBe("hello");
    } finally {
      await Promise.all([server.close(), server.close()]);
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cancels an active Web stream when a real client disconnects", async () => {
    const cancel = vi.fn();
    const server = await serve(
      {
        async handler() {
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
          );
        },
        async close() {},
      },
      { port: 0 },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const request = get(server.origin, (response) => {
          response.once("data", () => {
            response.destroy();
            resolve();
          });
        });
        request.once("error", reject);
      });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    } finally {
      await server.close();
    }
  });

  it("releases the application when the requested port is unavailable", async () => {
    const occupied = await serve(
      {
        async handler() {
          return new Response();
        },
        async close() {},
      },
      { port: 0 },
    );
    const close = vi.fn(async () => {});
    try {
      await expect(
        serve(
          {
            async handler() {
              return new Response();
            },
            close,
          },
          {
            port: Number(new URL(occupied.origin).port),
          },
        ),
      ).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await occupied.close();
    }
  });
});
