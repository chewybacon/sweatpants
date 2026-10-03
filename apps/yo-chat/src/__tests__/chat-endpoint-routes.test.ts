import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: vi.fn(),
  withDefaultSystemPrompt: vi.fn(async (request: Request) => request),
}));
vi.mock("@/server/chat-application", () => ({
  chatApp: { handler: mocks.handler },
  withDefaultSystemPrompt: mocks.withDefaultSystemPrompt,
}));
import { handleChatRequest } from "@/routes/api.chat";

describe("chat handler mounting", () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    ["POST", "/api/chat"],
    ["POST", "/api/chat/conversation-1"],
    ["GET", "/api/chat/conversation-1"],
    ["POST", "/api/chat/conversation-1/history:page"],
  ])("forwards %s %s to the application router", async (method, path) => {
    const response = new Response(null, { status: 200 });
    mocks.handler.mockResolvedValue(response);
    const request = new Request(`http://localhost${path}`, { method });
    await expect(handleChatRequest(request)).resolves.toBe(response);
    expect(mocks.handler).toHaveBeenCalledWith(request);
  });

  it("forwards the request projected by the system-prompt adapter", async () => {
    const incoming = new Request("http://localhost/api/chat", { method: "POST" });
    const projected = new Request(incoming.url, {
      method: "POST",
      headers: { "x-system-prompt-projected": "true" },
    });
    mocks.withDefaultSystemPrompt.mockResolvedValueOnce(projected);
    mocks.handler.mockResolvedValue(new Response(null));
    await handleChatRequest(incoming);
    expect(mocks.withDefaultSystemPrompt).toHaveBeenCalledWith(incoming);
    expect(mocks.handler).toHaveBeenCalledWith(projected);
  });
});
