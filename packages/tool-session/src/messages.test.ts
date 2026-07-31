import { describe, expect, it } from "vitest";
import type { ToolSampleConfig } from "@sweatpants/agent-sdk";
import { toModelMessages, type ExtendedMessage } from "./messages.ts";

describe("Tool Session model history projection", () => {
  it("specializes the Agent SDK sampling contract to canonical session history", () => {
    const config = {
      messages: [
        {
          role: "assistant",
          content: "Calling",
          toolCalls: [
            {
              id: "c1",
              type: "function",
              function: { name: "lookup", arguments: null },
            },
          ],
        },
        { role: "tool", content: "not found", tool_call_id: "c1", isError: true },
      ],
    } satisfies ToolSampleConfig<ExtendedMessage>;

    expect(config.messages).toHaveLength(2);

    const invalid: ToolSampleConfig<ExtendedMessage> = {
      messages: [
        // @ts-expect-error Tool Session specialization rejects foreign message roles.
        { role: "foreign", content: "x" },
      ],
    };
    void invalid;
  });

  it("preserves causal call identity, arguments, result, and failure", () => {
    const messages: ExtendedMessage[] = [
      { role: "user", content: "Book it" },
      {
        role: "assistant",
        content: "Calling",
        toolCalls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "book_flight", arguments: { destination: "NYC" } },
          },
        ],
      },
      {
        role: "tool",
        content: "the provider declined",
        tool_call_id: "call-1",
        isError: true,
      },
    ];

    expect(toModelMessages(messages)).toEqual([
      { role: "user", content: "Book it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Calling" },
          {
            type: "toolCall",
            toolCall: {
              id: "call-1",
              type: "function",
              function: { name: "book_flight", arguments: { destination: "NYC" } },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        name: "book_flight",
        content: "the provider declined",
        isError: true,
      },
    ]);
  });

  it("projects MCP blocks through the same causal identity path", () => {
    const messages: ExtendedMessage[] = [
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
    ];

    expect(toModelMessages(messages)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            toolCall: {
              id: "call-2",
              type: "function",
              function: { name: "weather", arguments: { city: "Paris" } },
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-2",
        name: "weather",
        content: [{ type: "text", text: "sunny" }],
        isError: false,
      },
    ]);
  });

  it("rejects orphan results instead of fabricating empty identity", () => {
    expect(() =>
      toModelMessages([
        {
          role: "tool",
          content: "orphan",
          tool_call_id: "missing",
          isError: false,
        },
      ]),
    ).toThrow('Tool result "missing" has no preceding tool call identity');
  });
});
