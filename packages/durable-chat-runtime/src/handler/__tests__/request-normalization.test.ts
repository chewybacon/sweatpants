import { describe, expect, it } from "vitest";

import { parseChatRequestBody } from "../request-normalization.ts";

function request(input: Record<string, unknown>, controls: Record<string, unknown> = {}) {
  return {
    input: {
      threadId: "thread-1",
      runId: "run-1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
      ...input,
    },
    ...controls,
  };
}

describe("parseChatRequestBody", () => {
  it("validates an AG-UI input nested inside the owned transport controls", () => {
    const parsed = parseChatRequestBody(
      request(
        {
          messages: [{ id: "user:1", role: "user", content: "hello" }],
          tools: [{ name: "client-plugin-contract", description: "client", parameters: {} }],
          resume: [{ interruptId: "interrupt:1", status: "cancelled" }],
          state: { step: 1 },
          forwardedProps: { source: "test" },
        },
        {
          trigger: "submit-message",
          clientId: "client-1",
          conversationId: "conversation-1",
          model: { provider: "test", id: "model" },
          pluginAbort: { sessionId: "tool:1", reason: "user_cancelled" },
          streamOptions: { toolChoice: "auto", maxTokens: 128 },
        },
      ),
    );

    expect(parsed.messages).toEqual([
      {
        type: "message",
        id: "user:1",
        message: { role: "user", content: "hello" },
        metadata: {},
      },
    ]);
    expect(parsed.threadId).toBe("thread-1");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.resume?.[0]?.status).toBe("cancelled");
    expect(parsed.model).toEqual({ provider: "test", id: "model" });
    expect(parsed.tools).toEqual([
      { name: "client-plugin-contract", description: "client", parameters: {} },
    ]);
  });

  it("uses the AG-UI and canonical Chat owner codecs for multimodal input", () => {
    const parsed = parseChatRequestBody(
      request({
        messages: [
          {
            id: "user:1",
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", source: { type: "url", value: "https://example.test/image.png" } },
            ],
          },
        ],
      }),
    );
    const entry = parsed.messages[0];
    expect(entry?.type).toBe("message");
    if (!entry || entry.type !== "message" || entry.message.role !== "user") {
      throw new Error("expected user history message entry");
    }
    expect(entry.message.content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "url", value: "https://example.test/image.png" },
        metadata: null,
      },
    ]);
  });

  it("converts native AG-UI tool argument text once and resolves a result name", () => {
    const parsed = parseChatRequestBody(
      request({
        messages: [
          {
            id: "assistant:1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: '{"query":"Ada"}' },
              },
            ],
          },
          { id: "tool:1", role: "tool", toolCallId: "call-1", content: "found" },
        ],
      }),
    );

    expect(parsed.messages).toMatchObject([
      {
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "" },
            {
              type: "tool-call",
              toolCall: {
                id: "call-1",
                name: "lookup",
                input: { query: "Ada" },
                thoughtSignature: null,
              },
            },
          ],
        },
      },
      {
        message: {
          role: "tool",
          toolCallId: "call-1",
          name: "lookup",
          content: "found",
          isError: false,
        },
      },
    ]);
  });

  it.each([
    ["non-object", null],
    ["missing transport input", {}],
    ["missing AG-UI tools", { input: { threadId: "t", runId: "r", state: {}, messages: [] } }],
    [
      "invalid AG-UI role",
      request({ messages: [{ id: "m", role: "future-role", content: "ignored" }] }),
    ],
    ["flattened message field", { messages: [] }],
    ["control nested inside protocol input", request({ trigger: "submit-message" })],
    [
      "legacy snake-case tool calls",
      request({ messages: [{ id: "a", role: "assistant", tool_calls: [] }] }),
    ],
    [
      "legacy snake-case result id",
      request({ messages: [{ id: "t", role: "tool", tool_call_id: "call" }] }),
    ],
    [
      "invalid native tool arguments",
      request({
        messages: [
          {
            id: "assistant:1",
            role: "assistant",
            toolCalls: [
              { id: "call", type: "function", function: { name: "lookup", arguments: "not-json" } },
            ],
          },
        ],
      }),
    ],
    [
      "binary AG-UI content",
      request({
        messages: [
          {
            id: "user:1",
            role: "user",
            content: [{ type: "binary", mimeType: "application/octet-stream", data: "AA==" }],
          },
        ],
      }),
    ],
  ])("rejects %s before turn planning", (_name, value) => {
    expect(() => parseChatRequestBody(value)).toThrow(
      expect.objectContaining({ code: "invalid_chat_request" }),
    );
  });
});
