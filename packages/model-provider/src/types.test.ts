import { describe, expect, it } from "vitest";
import type { ToolCall, ToolCallBlock, ToolResultMessage } from "./types.ts";

describe("settled model tool calls", () => {
  it("owns the decoded OpenAI-compatible call carried by downstream runtimes", () => {
    const toolCall = {
      id: "call-1",
      type: "function",
      function: {
        name: "book_flight",
        arguments: { destination: "LAX" },
      },
    } satisfies ToolCall;
    const block = { type: "toolCall", toolCall } satisfies ToolCallBlock;

    expect(block.toolCall).toBe(toolCall);
    expect(block.toolCall.function.arguments).toEqual({ destination: "LAX" });
  });

  it("pairs settled calls with explicit OpenAI-compatible result correlation", () => {
    const result = {
      role: "tool",
      tool_call_id: "call-1",
      name: "book_flight",
      content: "Error: no matches found",
      isError: false,
    } satisfies ToolResultMessage;

    expect(result).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      name: "book_flight",
      isError: false,
    });
  });

  it("does not treat provider partial fragments as settled calls", () => {
    // @ts-expect-error settled calls require decoded function identity and arguments.
    const partial: ToolCall = { id: "call-1", type: "function" };
    void partial;
  });
});
