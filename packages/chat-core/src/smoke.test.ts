import { describe, expect, it } from "vitest";
import type { Frame, HistoryPolicy, Message } from "@sweatpants/chat-core";
import type { ToolCall } from "@sweatpants/model-provider";
import { parseNDJSON } from "@sweatpants/chat-core";

describe("@sweatpants/chat-core smoke", () => {
  it("exports Message type", () => {
    const msg: Message = { id: "1", role: "user", content: "hello" };
    expect(msg.content).toBe("hello");
  });

  it("carries the Model Provider ToolCall type", () => {
    const call: ToolCall = {
      id: "call-1",
      type: "function",
      function: { name: "tool", arguments: {} },
    };
    expect(call.type).toBe("function");
  });

  it("exports Frame type", () => {
    const frame: Frame = { blocks: [], annotations: [], metadata: {} } as unknown as Frame;
    expect(frame.blocks).toEqual([]);
  });

  it("exports parseNDJSON utility", () => {
    expect(typeof parseNDJSON).toBe("function");
  });

  it("exports HistoryPolicy type", () => {
    const policy: HistoryPolicy = {
      name: "test",
      apply: () => ({ messages: [], decisions: [] }),
    };
    expect(policy.name).toBe("test");
  });
});
