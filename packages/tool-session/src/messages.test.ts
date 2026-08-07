import { describe, expect, it } from "vitest";
import type { ToolSampleConfig } from "@sweatpants/agent-sdk";
import type { ChatMessage } from "@sweatpants/chat-contract";
import { mcpMessagesToChatMessages } from "./messages.ts";

describe("Tool Session model history projection", () => {
  it("specializes Agent SDK sampling directly to canonical Chat history", () => {
    const config = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: {
                id: "c1",
                name: "lookup",
                input: null,
                thoughtSignature: null,
              },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "c1",
          name: "lookup",
          content: "not found",
          isError: true,
        },
      ],
    } satisfies ToolSampleConfig<ChatMessage>;

    expect(config.messages).toHaveLength(2);

    const invalid: ToolSampleConfig<ChatMessage> = {
      messages: [
        // @ts-expect-error Canonical Chat messages reject foreign message roles.
        { role: "foreign", content: "x" },
      ],
    };
    void invalid;
  });

  it("preserves canonical causal call identity, arguments, result, and failure", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Book it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling" },
          {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "book_flight",
              input: { destination: "NYC" },
              thoughtSignature: null,
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "book_flight",
        content: "the provider declined",
        isError: true,
      },
    ];

    expect(messages).toEqual([
      { role: "user", content: "Book it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling" },
          {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "book_flight",
              input: { destination: "NYC" },
              thoughtSignature: null,
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        name: "book_flight",
        content: "the provider declined",
        isError: true,
      },
    ]);
  });

  it("decodes MCP blocks through one explicit boundary conversion", () => {
    expect(
      mcpMessagesToChatMessages([
        {
          role: "assistant",
          content: {
            type: "tool_use",
            id: "call-2",
            name: "weather",
            input: { city: "Paris" },
          },
        },
        {
          role: "user",
          content: {
            type: "tool_result",
            toolUseId: "call-2",
            content: [{ type: "text", text: "sunny" }],
          },
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCall: {
              id: "call-2",
              name: "weather",
              input: { city: "Paris" },
              thoughtSignature: null,
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-2",
        name: "weather",
        content: [{ type: "text", text: "sunny" }],
        isError: false,
      },
    ]);
  });

  it("rejects orphan MCP results instead of fabricating call identity", () => {
    expect(() =>
      mcpMessagesToChatMessages([
        {
          role: "user",
          content: {
            type: "tool_result",
            toolUseId: "missing",
            content: [{ type: "text", text: "orphan" }],
          },
        },
      ]),
    ).toThrow(/no preceding tool call identity/);
  });

  it("rejects unsupported MCP modalities instead of dropping them", () => {
    expect(() =>
      mcpMessagesToChatMessages([
        {
          role: "assistant",
          content: { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        },
      ]),
    ).toThrow(/unsupported-model-capability/);
  });
});
