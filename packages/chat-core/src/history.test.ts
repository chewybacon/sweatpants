import { describe, expect, it } from "vitest";
import {
  ChatHistoryDecodeError,
  decodeChatHistoryEntries,
  decodeChatHistoryEntry,
} from "./history.ts";

function expectHistoryError(value: unknown, code: ChatHistoryDecodeError["code"]): void {
  expect(() => decodeChatHistoryEntry(value)).toThrowError(
    expect.objectContaining({ name: "ChatHistoryDecodeError", code }),
  );
}

describe("canonical Chat History composition", () => {
  it("wraps canonical messages without redeclaring role fields", () => {
    expect(
      decodeChatHistoryEntries([
        { type: "message", id: "u", message: { role: "user", content: "hello" } },
        {
          type: "message",
          id: "a",
          message: {
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
          },
        },
        {
          type: "message",
          id: "t",
          message: {
            role: "tool",
            toolCallId: "call-1",
            name: "lookup",
            content: "result",
            isError: false,
          },
        },
        {
          type: "activity",
          id: "activity",
          activityType: "progress",
          data: { step: 1 },
        },
      ]),
    ).toEqual([
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
        },
        metadata: {},
      },
      {
        type: "message",
        id: "t",
        message: {
          role: "tool",
          toolCallId: "call-1",
          name: "lookup",
          content: "result",
          isError: false,
        },
        metadata: {},
      },
      {
        type: "activity",
        id: "activity",
        activityType: "progress",
        data: { step: 1 },
        metadata: {},
      },
    ]);
  });

  it("normalizes and freezes history metadata once", () => {
    const entry = decodeChatHistoryEntry({
      type: "message",
      id: "user",
      message: { role: "user", content: "hello" },
    });
    expect(entry.metadata).toEqual({});
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metadata)).toBe(true);
    if (entry.type !== "message") throw new Error("expected message entry");
    expect(Object.isFrozen(entry.message)).toBe(true);
  });

  it("preserves explicit metadata and ordered assistant parts", () => {
    const entry = decodeChatHistoryEntry({
      type: "message",
      id: "assistant",
      metadata: { trace: [1, 2] },
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "tool-call", toolCall: { id: "call", name: "one", input: null } },
          { type: "text", text: "second" },
        ],
      },
    });
    expect(entry).toMatchObject({ metadata: { trace: [1, 2] } });
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      throw new Error("expected assistant message entry");
    }
    expect(entry.message.content.map((part) => part.type)).toEqual(["text", "tool-call", "text"]);
  });

  it("rejects old flattened role records and synthetic reasoning roles", () => {
    expectHistoryError({ id: "u", role: "user", content: "hi" }, "missing-field");
    expectHistoryError(
      { type: "message", id: "r", message: { role: "reasoning", content: "why" } },
      "invalid-message",
    );
    expectHistoryError(
      {
        type: "message",
        id: "a",
        message: { role: "assistant", content: [], toolCalls: [] },
      },
      "invalid-message",
    );
  });

  it("rejects malformed activities and non-JSON metadata", () => {
    expectHistoryError(
      { type: "activity", id: "activity", activityType: "progress" },
      "missing-field",
    );
    expectHistoryError(
      {
        type: "message",
        id: "u",
        message: { role: "user", content: "hi" },
        metadata: new Date(),
      },
      "invalid-value",
    );
  });

  it("requires an array for history collections", () => {
    expect(() => decodeChatHistoryEntries({})).toThrow(ChatHistoryDecodeError);
    expect(() => decodeChatHistoryEntries([null])).toThrow(ChatHistoryDecodeError);
  });
});
