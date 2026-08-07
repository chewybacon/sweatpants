import { describe, expect, it } from "vitest";
import { applyHistoryPolicy, createMessageBudgetHistoryPolicy } from "@sweatpants/chat-core";
import type { ChatMessage } from "@sweatpants/chat-contract";
import type { ModelContext } from "@sweatpants/model-provider";

function user(content: string): ChatMessage {
  return { role: "user", content };
}
function assistantText(text: string): ChatMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function assistantCall(id: string, name = "echo"): ChatMessage {
  return {
    role: "assistant",
    content: [{ type: "tool-call", toolCall: { id, name, input: {}, thoughtSignature: null } }],
  };
}
function toolResult(id: string): ChatMessage {
  return { role: "tool", toolCallId: id, name: "echo", content: "ok", isError: false };
}
function context(messages: ChatMessage[]): ModelContext {
  return { messages, tools: [] };
}

describe("applyHistoryPolicy", () => {
  it("is identity when no policy is installed", () => {
    const value = context([user("hi")]);
    const result = applyHistoryPolicy(undefined, value);
    expect(result.context).toBe(value);
    expect(result.decisions).toEqual([]);
  });

  it("returns original context when the policy makes no decisions", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 10 });
    const value = context([user("hi"), assistantText("hello")]);
    const result = applyHistoryPolicy(policy, value);
    expect(result.context).toBe(value);
    expect(result.decisions).toEqual([]);
  });
});

describe("createMessageBudgetHistoryPolicy", () => {
  it("rejects non-positive budgets", () => {
    expect(() => createMessageBudgetHistoryPolicy({ maxMessages: 0 })).toThrow(/positive integer/);
  });

  it("drops whole oldest turns and records calls", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 4 });
    const messages = [
      user("turn one"),
      assistantCall("call-1"),
      toolResult("call-1"),
      assistantText("done one"),
      user("turn two"),
      assistantText("done two"),
    ];
    const result = policy.apply({ messages });
    expect(result.messages).toEqual([user("turn two"), assistantText("done two")]);
    expect(result.decisions[0]).toMatchObject({
      action: "drop_turn",
      toolCallIds: ["call-1", "call-1"],
    });
    expect(result.decisions[0]!.roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("never splits a completed call/result pair", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 5 });
    const messages = [
      user("turn one"),
      assistantText("done one"),
      user("turn two"),
      assistantCall("call-2"),
      toolResult("call-2"),
      assistantText("done two"),
    ];
    const result = policy.apply({ messages });
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const callIds = result.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCall.id] : []))
        : message.role === "tool"
          ? [message.toolCallId]
          : [],
    );
    expect(callIds).toEqual(["call-2", "call-2"]);
  });

  it("always retains the newest oversized turn", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 2 });
    const messages = [
      user("old"),
      assistantText("old answer"),
      user("new"),
      assistantCall("call-9"),
      toolResult("call-9"),
      assistantText("new answer"),
    ];
    const result = policy.apply({ messages });
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.decisions).toHaveLength(1);
  });

  it("preserves system messages outside the budget", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 2 });
    const system: ChatMessage = { role: "system", content: "you are helpful" };
    const result = policy.apply({
      messages: [
        system,
        user("old"),
        assistantText("old answer"),
        user("new"),
        assistantText("new answer"),
      ],
    });
    expect(result.messages[0]).toEqual(system);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("does not mutate input messages", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 1 });
    const messages = [user("one"), assistantText("a"), user("two")];
    const snapshot = structuredClone(messages);
    policy.apply({ messages });
    expect(messages).toEqual(snapshot);
  });
});
