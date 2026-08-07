import { describe, expect, it } from "vitest";
import {
  ChatMessageDecodeError,
  decodeChatMessage,
  decodeChatMessages,
  decodeChatToolCall,
  decodeChatToolDefinition,
} from "./message.ts";

function expectMessageError(value: unknown, code: ChatMessageDecodeError["code"]): void {
  expect(() => decodeChatMessage(value)).toThrowError(
    expect.objectContaining({ name: "ChatMessageDecodeError", code }),
  );
}

describe("canonical Chat messages", () => {
  it("decodes every role without lifecycle or provider fields", () => {
    expect(decodeChatMessage({ role: "user", content: "hello" })).toEqual({
      role: "user",
      content: "hello",
    });
    expect(decodeChatMessage({ role: "system", content: "rules" })).toEqual({
      role: "system",
      content: "rules",
    });
    expect(decodeChatMessage({ role: "developer", content: "constraints" })).toEqual({
      role: "developer",
      content: "constraints",
    });
    expect(
      decodeChatMessage({
        role: "tool",
        toolCallId: "call-1",
        name: "lookup",
        content: "result",
        isError: false,
      }),
    ).toEqual({
      role: "tool",
      toolCallId: "call-1",
      name: "lookup",
      content: "result",
      isError: false,
    });
  });

  it("preserves one ordered assistant part sequence", () => {
    const message = decodeChatMessage({
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        {
          type: "tool-call",
          toolCall: { id: "call-1", name: "lookup", input: { q: "x" } },
        },
        { type: "reasoning", text: "because" },
        { type: "text", text: "after" },
      ],
    });

    expect(message).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        {
          type: "tool-call",
          toolCall: {
            id: "call-1",
            name: "lookup",
            input: { q: "x" },
            thoughtSignature: null,
          },
        },
        {
          type: "reasoning",
          text: "because",
          format: null,
          signature: null,
          redacted: false,
        },
        { type: "text", text: "after" },
      ],
    });
    expect(Object.isFrozen(message)).toBe(true);
    expect(Object.isFrozen(message.content)).toBe(true);
  });

  it("rejects synthetic roles, parallel call arrays, and lifecycle fields", () => {
    expectMessageError({ role: "reasoning", content: "no" }, "invalid-role");
    expectMessageError({ role: "assistant", content: [], toolCalls: [] }, "unknown-field");
    expectMessageError({ role: "user", content: "hello", id: "history-id" }, "unknown-field");
    expectMessageError({ role: "assistant", content: [], usage: { input: 1 } }, "unknown-field");
  });

  it("decodes and freezes ordered message arrays", () => {
    const messages = decodeChatMessages([
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]);
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(Object.isFrozen(messages)).toBe(true);
  });
});

describe("canonical calls and definitions", () => {
  it("normalizes meaningful absence exactly once", () => {
    expect(decodeChatToolCall({ id: "call-1", name: "lookup", input: { q: "x" } })).toEqual({
      id: "call-1",
      name: "lookup",
      input: { q: "x" },
      thoughtSignature: null,
    });
    expect(decodeChatToolDefinition({ name: "lookup", parameters: { type: "object" } })).toEqual({
      name: "lookup",
      description: null,
      parameters: { type: "object" },
    });
  });

  it("rejects malformed calls and copied definition fields", () => {
    expect(() => decodeChatToolCall({ id: "call-1", name: "lookup" })).toThrowError(
      expect.objectContaining({ code: "missing-field", path: "$.input" }),
    );
    expect(() =>
      decodeChatToolCall({ id: "call-1", name: "lookup", input: new Date() }),
    ).toThrowError(expect.objectContaining({ code: "invalid-value" }));
    expect(() =>
      decodeChatToolDefinition({
        name: "lookup",
        parameters: { type: "object" },
        inputSchema: { type: "object" },
      }),
    ).toThrowError(expect.objectContaining({ code: "unknown-field" }));
  });
});
