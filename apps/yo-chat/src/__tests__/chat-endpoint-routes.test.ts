import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postChat: vi.fn(),
  readChat: vi.fn(),
  pageHistory: vi.fn(),
  handleEndpoint: vi.fn(),
  withDefaultSystemPrompt: vi.fn(async (request: Request) => request),
}));

vi.mock("@/server/chat-application", () => ({
  chatApp: {
    endpoints: {
      postChat: mocks.postChat,
      readChat: mocks.readChat,
      pageHistory: mocks.pageHistory,
    },
    handleEndpoint: mocks.handleEndpoint,
  },
  withDefaultSystemPrompt: mocks.withDefaultSystemPrompt,
}));

import { chatApp } from "@/server/chat-application";
import { postNativeChat } from "@/routes/api.chat";
import { reconnectNativeChat } from "@/routes/api/chat/$conversationId";
import { pageNativeHistory } from "@/routes/api/chat/$conversationId/history:page";

describe("native chat route endpoints", () => {
  afterEach(() => vi.clearAllMocks());

  it("routes POST chat commands to the command endpoint", async () => {
    const response = new Response(null, { status: 200 });
    vi.mocked(chatApp.handleEndpoint).mockResolvedValue(response);
    const request = new Request("http://localhost/api/chat", { method: "POST" });

    await expect(postNativeChat(request)).resolves.toBe(response);

    expect(mocks.withDefaultSystemPrompt).toHaveBeenCalledWith(request);
    expect(chatApp.handleEndpoint).toHaveBeenCalledWith(chatApp.endpoints.postChat, request);
  });

  it("forwards the request projected by the system-prompt adapter", async () => {
    const response = new Response(null, { status: 200 });
    const incoming = new Request("http://localhost/api/chat", { method: "POST" });
    const projected = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "x-system-prompt-projected": "true" },
    });
    mocks.withDefaultSystemPrompt.mockResolvedValueOnce(projected);
    vi.mocked(chatApp.handleEndpoint).mockResolvedValue(response);

    await postNativeChat(incoming);

    expect(chatApp.handleEndpoint).toHaveBeenCalledWith(chatApp.endpoints.postChat, projected);
  });

  it("passes the router-decoded conversation to the read endpoint", async () => {
    const response = new Response(null, { status: 200 });
    vi.mocked(chatApp.handleEndpoint).mockResolvedValue(response);
    const request = new Request("http://localhost/api/chat/conversation-1", { method: "POST" });

    await expect(reconnectNativeChat(request, "conversation-1")).resolves.toBe(response);

    expect(chatApp.handleEndpoint).toHaveBeenCalledWith(chatApp.endpoints.readChat, {
      request,
      conversationId: "conversation-1",
    });
  });

  it("passes the router-decoded conversation to the history endpoint", async () => {
    const response = new Response(null, { status: 200 });
    vi.mocked(chatApp.handleEndpoint).mockResolvedValue(response);
    const request = new Request("http://localhost/api/chat/conversation-1/history:page", {
      method: "POST",
    });

    await expect(pageNativeHistory(request, "conversation-1")).resolves.toBe(response);

    expect(chatApp.handleEndpoint).toHaveBeenCalledWith(chatApp.endpoints.pageHistory, {
      request,
      conversationId: "conversation-1",
    });
  });
});
