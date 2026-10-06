import { describe, expect, it, vi } from "vitest";
import { createChatFetchHandler } from "../request-handler.ts";

const request = () => new Request("https://chat.test/api/chat");

describe("request-owned chat applications", () => {
  it("does not read ahead and closes exactly once at EOF", async () => {
    let reads = 0;
    const close = vi.fn(async () => {});
    const handler = createChatFetchHandler(() => ({
      close,
      handler: async () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                reads++;
                if (reads <= 2) controller.enqueue(new Uint8Array([reads]));
                else controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { status: 202, headers: { "x-chat": "stream" } },
        ),
    }));
    const response = await handler(request());
    await Promise.resolve();
    expect(reads).toBe(0);
    expect(response.status).toBe(202);
    expect(response.headers.get("x-chat")).toBe("stream");
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([1]) });
    expect(reads).toBe(1);
    expect(close).not.toHaveBeenCalled();
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([2]) });
    expect(reads).toBe(2);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await reader.cancel();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cancels an unread response without starting the source", async () => {
    const close = vi.fn(async () => {});
    const cancel = vi.fn();
    const pull = vi.fn();
    const handler = createChatFetchHandler(() => ({
      close,
      handler: async () => new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })),
    }));
    const response = await handler(request());
    await response.body!.cancel("disconnected");
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith("disconnected");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes when aborting the request interrupts a pending read", async () => {
    const abort = new AbortController();
    const close = vi.fn(async () => {});
    const failure = new Error("client disconnected");
    const handler = createChatFetchHandler(() => ({
      close,
      handler: async (input) =>
        new Response(
          new ReadableStream(
            {
              start(controller) {
                input.signal.addEventListener(
                  "abort",
                  () => controller.error(input.signal.reason),
                  { once: true },
                );
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    }));
    const response = await handler(new Request("https://chat.test", { signal: abort.signal }));
    const read = response.body!.getReader().read();
    abort.abort(failure);
    await expect(read).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("exposes both stream and teardown failures", async () => {
    const failure = new Error("stream failed");
    const cleanup = new Error("cleanup failed");
    const close = vi.fn(async () => {
      throw cleanup;
    });
    const handler = createChatFetchHandler(() => ({
      close,
      handler: async () =>
        new Response(
          new ReadableStream(
            {
              pull() {
                throw failure;
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    }));
    const response = await handler(request());
    await expect(response.body!.getReader().read()).rejects.toMatchObject({
      errors: [failure, cleanup],
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes applications that throw before headers or return no body", async () => {
    const close = vi.fn(async () => {});
    const failure = new Error("setup failed");
    const broken = createChatFetchHandler(() => ({
      close,
      handler: async () => {
        throw failure;
      },
    }));
    await expect(broken(request())).rejects.toBe(failure);
    const empty = createChatFetchHandler(() => ({
      close,
      handler: async () => new Response(null, { status: 204 }),
    }));
    expect((await empty(request())).status).toBe(204);
    expect(close).toHaveBeenCalledTimes(2);
  });
});
