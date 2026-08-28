import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readChat: vi.fn(),
  handleEndpoint: vi.fn(),
}));

vi.mock("@/server/chat-application", () => ({
  chatApp: {
    endpoints: { readChat: mocks.readChat },
    handleEndpoint: mocks.handleEndpoint,
  },
}));

import { chatApp } from "@/server/chat-application";
import { readNativeChat } from "@/routes/api/streams/chat/$threadId";

describe("native chat stream route", () => {
  afterEach(() => vi.clearAllMocks());

  it("passes route-owned reconnect identity to the read endpoint", async () => {
    const upstream = new Response('{"type":"sweatpants.conversation-window.v1"}\n', {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
    vi.mocked(chatApp.handleEndpoint).mockResolvedValue(upstream);
    const request = new Request("http://localhost/api/streams/chat/thread-1", {
      method: "GET",
      headers: { "x-known-window-token": "opaque-token" },
    });

    const response = await readNativeChat(request, "thread-1");

    expect(chatApp.handleEndpoint).toHaveBeenCalledWith(chatApp.endpoints.readChat, {
      request,
      conversationId: "thread-1",
      knownWindowToken: "opaque-token",
    });
    expect(await response.text()).toBe('{"type":"sweatpants.conversation-window.v1"}\n');
  });

  it("omits an absent window token", async () => {
    vi.mocked(chatApp.handleEndpoint).mockResolvedValue(new Response(null, { status: 404 }));
    const request = new Request("http://localhost/api/streams/chat/thread-2");

    await readNativeChat(request, "thread-2");

    expect(chatApp.handleEndpoint).toHaveBeenCalledWith(chatApp.endpoints.readChat, {
      request,
      conversationId: "thread-2",
    });
  });
});
