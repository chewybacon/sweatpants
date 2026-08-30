import { describe, expect, it } from "vitest";
import {
  ChatConversionError,
  agUiMessageToChatHistoryEntry,
  agUiMessagesToChatHistoryEntries,
  chatHistoryEntryToAgUiMessage,
  chatHistoryEntriesToAgUiMessages,
} from "../index.ts";

describe("AG-UI and composed Chat History conversion", () => {
  it("decodes ordered AG-UI user content into a canonical message entry", () => {
    expect(
      agUiMessageToChatHistoryEntry({
        id: "user-1",
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image", source: { type: "url", value: "https://example.test/a.png" } },
          { type: "text", text: "after" },
        ],
      }),
    ).toEqual({
      type: "message",
      id: "user-1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "before" },
          {
            type: "image",
            source: { type: "url", value: "https://example.test/a.png" },
            metadata: null,
          },
          { type: "text", text: "after" },
        ],
      },
      metadata: {},
    });
  });

  it("decodes assistant calls and correlates tool results over an array", () => {
    expect(
      agUiMessagesToChatHistoryEntries([
        {
          id: "assistant-1",
          role: "assistant",
          content: "looking up",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        { id: "tool-1", role: "tool", toolCallId: "call-1", content: "result" },
      ]),
    ).toEqual([
      {
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "looking up" },
            {
              type: "tool-call",
              toolCall: {
                id: "call-1",
                name: "lookup",
                input: { q: "x" },
                thoughtSignature: null,
              },
            },
          ],
        },
        metadata: {},
      },
      {
        type: "message",
        id: "tool-1",
        message: {
          role: "tool",
          toolCallId: "call-1",
          name: "lookup",
          content: "result",
          isError: false,
        },
        metadata: {},
      },
    ]);
  });

  it("projects representable history entries back to AG-UI", () => {
    expect(
      chatHistoryEntriesToAgUiMessages([
        {
          type: "message",
          id: "u",
          message: { role: "user", content: "hello" },
          metadata: {},
        },
        {
          type: "message",
          id: "a",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "answer" },
              {
                type: "tool-call",
                toolCall: {
                  id: "c",
                  name: "lookup",
                  input: { q: "x" },
                  thoughtSignature: null,
                },
              },
            ],
          },
          metadata: {},
        },
      ]),
    ).toEqual([
      { id: "u", role: "user", content: "hello" },
      {
        id: "a",
        role: "assistant",
        content: "answer",
        toolCalls: [
          { id: "c", type: "function", function: { name: "lookup", arguments: '{"q":"x"}' } },
        ],
      },
    ]);
  });

  it("rejects binary content and malformed tool arguments", () => {
    expect(() =>
      agUiMessageToChatHistoryEntry({
        id: "user-1",
        role: "user",
        content: [{ type: "binary", mimeType: "application/octet-stream", data: "AA==" }],
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-binary-content" }));

    expect(() =>
      agUiMessageToChatHistoryEntry({
        id: "assistant-1",
        role: "assistant",
        content: "call",
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "lookup", arguments: "not-json" } },
        ],
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid-tool-arguments" }));
  });

  it("rejects reverse projections that would lose part order or metadata", () => {
    expect(() =>
      chatHistoryEntryToAgUiMessage({
        type: "message",
        id: "assistant-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCall: {
                id: "call",
                name: "lookup",
                input: {},
                thoughtSignature: null,
              },
            },
            { type: "text", text: "post-call text" },
          ],
        },
        metadata: {},
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-content" }));

    expect(() =>
      chatHistoryEntryToAgUiMessage({
        type: "message",
        id: "tool-1",
        message: {
          role: "tool",
          toolCallId: "call-1",
          name: "lookup",
          content: "result",
          isError: false,
        },
        metadata: {},
      }),
    ).toThrow(ChatConversionError);

    expect(() =>
      chatHistoryEntryToAgUiMessage({
        type: "message",
        id: "user-1",
        message: { role: "user", content: "hello" },
        metadata: { trace: "not representable in AG-UI" },
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-content" }));
  });

  it("rejects isolated tool results and encrypted AG-UI values", () => {
    expect(() =>
      agUiMessageToChatHistoryEntry({
        id: "tool-1",
        role: "tool",
        toolCallId: "missing",
        content: "result",
      }),
    ).toThrowError(expect.objectContaining({ code: "missing-tool-identity" }));

    expect(() =>
      agUiMessageToChatHistoryEntry({
        id: "user-1",
        role: "user",
        content: "hello",
        encryptedValue: "secret",
      }),
    ).toThrowError(expect.objectContaining({ code: "unsupported-content" }));
  });
});
