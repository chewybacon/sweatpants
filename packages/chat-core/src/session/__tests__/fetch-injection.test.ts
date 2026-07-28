import { describe, expect, it } from "vitest";
import { run } from "effection";
import type { ChatFetch } from "../options.ts";
import { executeChatFetch } from "../api-transport.ts";
import { readDurableHistory } from "../durable-history.ts";

describe("chat fetch injection", () => {
  it("uses the injected function for chat POST", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const injected: ChatFetch = async (input, init) => {
      calls.push({ input, ...(init ? { init } : {}) });
      return new Response("stream", { status: 200 });
    };
    await run(function* () {
      yield* executeChatFetch("/api/chat", [], { fetch: injected }, new AbortController().signal);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("/api/chat");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("uses the same injected function for relative durable-history reads", async () => {
    let requested: string | undefined;
    const injected: ChatFetch = async (input) => {
      requested = String(input);
      return new Response("", { status: 200 });
    };
    const replay = await run(function* () {
      return yield* readDurableHistory({
        baseUrl: "/api/chat",
        conversationId: "conversation-1",
        fetch: injected,
      });
    });
    expect(requested).toBe("/api/chat?conversationId=conversation-1&offset=0");
    expect(replay.history).toEqual([]);
  });
});
