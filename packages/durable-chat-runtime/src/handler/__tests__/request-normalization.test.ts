import { describe, expect, it } from "vitest";

import { parseChatRequestBody } from "../request-normalization.ts";

describe("parseChatRequestBody", () => {
  it("parses the complete owned request shape and normalizes supported messages", () => {
    const parsed = parseChatRequestBody({
      messages: [{ id: "user:1", role: "user", content: "hello" }],
      model: { provider: "test", id: "model" },
      resume: [{ interruptId: "interrupt:1", status: "cancelled" }],
      pluginAbort: { sessionId: "tool:1", reason: "user_cancelled" },
      streamOptions: { toolChoice: "auto", maxTokens: 128 },
      state: { step: 1 },
      tools: [{ name: "client-plugin-contract" }],
    });

    expect(parsed.messages).toEqual([{ id: "user:1", role: "user", content: "hello" }]);
    expect(parsed.resume?.[0]?.status).toBe("cancelled");
    expect(parsed.model).toEqual({ provider: "test", id: "model" });
    expect(parsed.tools).toEqual([{ name: "client-plugin-contract" }]);
  });

  it.each([
    ["non-object", null],
    ["missing messages", {}],
    ["invalid message role", { messages: [{ role: "future-role", content: "ignored" }] }],
    ["tool message without call ID", { messages: [{ role: "tool", content: "result" }] }],
    ["invalid resume status", { messages: [], resume: [{ interruptId: "i", status: "done" }] }],
    ["missing resume ID", { messages: [], resume: [{ status: "resolved" }] }],
    ["unknown owned field", { messages: [], unexpected: true }],
    ["removed client inventory field", { messages: [], enabledTools: true }],
    [
      "malformed nested tool call",
      {
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call", type: "function", function: { name: 42, arguments: {} } }],
          },
        ],
      },
    ],
  ])("rejects %s before turn planning", (_name, value) => {
    try {
      parseChatRequestBody(value);
      throw new Error("expected request parsing to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_chat_request" });
    }
  });
});
