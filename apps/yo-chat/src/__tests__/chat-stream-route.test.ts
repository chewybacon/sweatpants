import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/chat-application", () => ({
  chatApp: { handle: vi.fn() },
}));

import { chatApp } from "@/server/chat-application";
import { forwardNativeChatRead } from "@/routes/api/streams/chat/$threadId";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("native chat stream route", () => {
  afterEach(() => vi.restoreAllMocks());

  it("forwards a cursor-free reconnect POST without rewriting direct values", async () => {
    const upstream = new Response('{"type":"sweatpants.conversation-window.v1"}\n', {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
    const handleSpy = vi.spyOn(chatApp, "handle").mockResolvedValue(upstream);

    const response = await forwardNativeChatRead(
      new Request("http://localhost/api/streams/chat/thread-1", {
        method: "GET",
        headers: { "x-client-id": "client-1", "x-known-window-token": "opaque-token" },
      }),
      "thread-1",
    );

    const forwarded = handleSpy.mock.calls[0]![0];
    expect(new URL(forwarded.url).pathname).toBe("/api/chat");
    expect(forwarded.method).toBe("POST");
    expect(await forwarded.json()).toEqual({
      clientId: "client-1",
      conversationId: "thread-1",
      knownWindowToken: "opaque-token",
    });
    expect(await response.text()).toBe('{"type":"sweatpants.conversation-window.v1"}\n');
  });

  it("declares only a cursor-free GET adapter", () => {
    const source = readFileSync(join(__dirname, "../routes/api/streams/chat/$threadId.ts"), "utf8");
    const declaredMethods = [...source.matchAll(/^\s*(GET|HEAD|POST|PUT|DELETE|PATCH):\s/gm)].map(
      (match) => match[1],
    );
    expect(declaredMethods).toEqual(["GET"]);
    expect(source).not.toContain("offset");
    expect(source).not.toContain(["X", "Session", "Id"].join("-"));
  });
});
