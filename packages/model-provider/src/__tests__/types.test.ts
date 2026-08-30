import { describe, expect, it } from "vitest";
import type {
  ChatToolCall,
  ChatToolCallPart,
  ChatToolResultMessage,
} from "@sweatpants/chat-contract";

describe("canonical model tool calls", () => {
  it("uses the canonical decoded call carried by model operations", () => {
    const toolCall = {
      id: "call-1",
      name: "book_flight",
      input: { destination: "LAX" },
      thoughtSignature: null,
    } satisfies ChatToolCall;
    const part = { type: "tool-call", toolCall } satisfies ChatToolCallPart;

    expect(part.toolCall).toBe(toolCall);
    expect(part.toolCall.input).toEqual({ destination: "LAX" });
  });

  it("pairs settled calls with explicit canonical result correlation", () => {
    const result = {
      role: "tool",
      toolCallId: "call-1",
      name: "book_flight",
      content: "Error: no matches found",
      isError: false,
    } satisfies ChatToolResultMessage;

    expect(result).toMatchObject({
      role: "tool",
      toolCallId: "call-1",
      name: "book_flight",
      isError: false,
    });
  });
});
