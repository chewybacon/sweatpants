import { describe, expect, it } from "vitest";
import { applyHistoryPolicy, createMessageBudgetHistoryPolicy } from "@sweatpants/chat-core";
import type { PortableModelContextMessage } from "@sweatpants/model-provider";

function user(content: string): PortableModelContextMessage {
  return { role: "user", content };
}

function assistantText(text: string): PortableModelContextMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantCall(id: string, name = "echo"): PortableModelContextMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        toolCall: { id, type: "function", function: { name, arguments: {} } },
      },
    ],
  };
}

function toolResult(id: string): PortableModelContextMessage {
  return {
    role: "tool",
    tool_call_id: id,
    name: "echo",
    content: [{ type: "text", text: "ok" }],
    isError: false,
  };
}

describe("applyHistoryPolicy", () => {
  it("is identity when no policy is installed", () => {
    const context = { messages: [user("hi")] };
    const result = applyHistoryPolicy(undefined, context);
    expect(result.context).toBe(context);
    expect(result.decisions).toEqual([]);
  });

  it("returns the original context when the policy makes no decisions", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 10 });
    const context = { messages: [user("hi"), assistantText("hello")] };
    const result = applyHistoryPolicy(policy, context);
    expect(result.context).toBe(context);
    expect(result.decisions).toEqual([]);
  });
});

describe("createMessageBudgetHistoryPolicy", () => {
  it("rejects non-positive budgets", () => {
    expect(() => createMessageBudgetHistoryPolicy({ maxMessages: 0 })).toThrow(/positive integer/);
  });

  it("drops whole oldest turns and records one decision per turn", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 4 });
    const messages: PortableModelContextMessage[] = [
      user("turn one"),
      assistantCall("call-1"),
      toolResult("call-1"),
      assistantText("done one"),
      user("turn two"),
      assistantText("done two"),
    ];

    const result = policy.apply({ messages });

    // Only the newest turn fits within the budget of 4.
    expect(result.messages).toEqual([user("turn two"), assistantText("done two")]);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toMatchObject({
      action: "drop_turn",
      toolCallIds: ["call-1", "call-1"],
    });
    expect(result.decisions[0]!.roles).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("never splits a completed call/result pair across the retention boundary", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 5 });
    const messages: PortableModelContextMessage[] = [
      user("turn one"),
      assistantText("done one"),
      user("turn two"),
      assistantCall("call-2"),
      toolResult("call-2"),
      assistantText("done two"),
    ];

    const result = policy.apply({ messages });

    // Turn two is 4 messages; adding turn one's 2 would exceed 5, so turn one
    // drops entirely rather than partially (which would orphan nothing here,
    // but the invariant is that removal is turn-granular).
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const callIds = result.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.toolCall.id] : []))
        : message.role === "tool"
          ? [message.tool_call_id]
          : [],
    );
    // Every remaining call has its result and vice versa.
    expect(callIds).toEqual(["call-2", "call-2"]);
  });

  it("always retains the newest turn even when it alone exceeds the budget", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 2 });
    const messages: PortableModelContextMessage[] = [
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
    const system: PortableModelContextMessage = { role: "system", content: "you are helpful" };
    const messages: PortableModelContextMessage[] = [
      system,
      user("old"),
      assistantText("old answer"),
      user("new"),
      assistantText("new answer"),
    ];

    const result = policy.apply({ messages });
    expect(result.messages[0]).toEqual(system);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
  });

  it("does not mutate the input messages", () => {
    const policy = createMessageBudgetHistoryPolicy({ maxMessages: 1 });
    const messages: PortableModelContextMessage[] = [user("one"), assistantText("a"), user("two")];
    const snapshot = structuredClone(messages);
    policy.apply({ messages });
    expect(messages).toEqual(snapshot);
  });
});
