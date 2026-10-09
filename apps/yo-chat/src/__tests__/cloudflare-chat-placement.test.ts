// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { chatHostPlacement, createCloudflareChatRouter } from "../server/cloudflare-chat-placement";

describe("Cloudflare conversation placement", () => {
  it("keeps the Worker path independent of a conversation namespace", async () => {
    const response = new Response("worker");
    const worker = vi.fn(async () => response);
    const getByName = vi.fn(() => {
      throw new Error("DO must not be used");
    });
    const request = new Request("https://chat/api/chat", { method: "POST", body: "untouched" });
    const handler = createCloudflareChatRouter({
      placement: "worker",
      conversations: { getByName },
      worker,
    });
    expect(await handler(request)).toBe(response);
    expect(worker).toHaveBeenCalledWith(request);
    expect(request.bodyUsed).toBe(false);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("routes commands, reconnects, and history to the same conversation without consuming the response", async () => {
    const requests: Request[] = [];
    const reads = vi.fn();
    const response = new Response(new ReadableStream({ pull: reads }, { highWaterMark: 0 }));
    const getByName = vi.fn((_name: string) => ({
      fetch: async (request: Request) => {
        requests.push(request);
        return response;
      },
    }));
    const worker = vi.fn(async () => new Response("wrong placement"));
    const handler = createCloudflareChatRouter({
      placement: "durable-object",
      conversations: { getByName },
      worker,
    });
    const body = { conversationId: "cards:one", command: { type: "send-message" } };
    for (const request of [
      new Request("https://chat/api/chat", { method: "POST", body: JSON.stringify(body) }),
      new Request("https://chat/api/chat/cards%3Aone"),
      new Request("https://chat/api/chat/cards%3Aone", { method: "POST", body: "reconnect" }),
      new Request("https://chat/api/chat/cards%3Aone/history:page", {
        method: "POST",
        body: "history",
      }),
    ]) {
      expect(await handler(request)).toBe(response);
    }
    expect(getByName.mock.calls.map(([name]) => name)).toEqual(Array(4).fill("cards:one"));
    expect(await requests[0]!.json()).toEqual(body);
    expect(await requests[2]!.text()).toBe("reconnect");
    expect(await requests[3]!.text()).toBe("history");
    expect(reads).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    await response.body!.cancel();
  });

  it("rejects malformed and oversized routing bodies before contacting a DO", async () => {
    const getByName = vi.fn(() => ({ fetch: async () => new Response("unexpected") }));
    const handler = createCloudflareChatRouter({
      placement: "durable-object",
      conversations: { getByName },
      worker: async () => new Response(),
    });
    for (const [body, status] of [
      ["{", 400],
      ['{"conversationId":" "}', 400],
      ["x".repeat(2 * 1024 * 1024 + 1), 413],
    ] as const) {
      const response = await handler(
        new Request("https://chat/api/chat", { method: "POST", body }),
      );
      expect(response.status).toBe(status);
    }
    expect((await handler(new Request("https://chat/api/chat/%zz"))).status).toBe(400);
    expect((await handler(new Request("https://chat/api/chat/a/unknown"))).status).toBe(404);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("rejects unknown placement instead of falling back", () => {
    expect(chatHostPlacement(undefined)).toBe("worker");
    expect(chatHostPlacement("worker")).toBe("worker");
    expect(chatHostPlacement("durable-object")).toBe("durable-object");
    expect(() => chatHostPlacement("workers")).toThrow("Invalid CHAT_HOST_PLACEMENT");
  });
});
