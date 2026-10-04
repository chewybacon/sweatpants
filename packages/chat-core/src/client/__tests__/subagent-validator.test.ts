import { describe, expect, it } from "vitest";
import { SubagentValidator } from "../subagent-validator.ts";
import { decodeAGUIEvent } from "../chat-client-codec.ts";

function validator() {
  const instance = new SubagentValidator((message) => {
    throw new Error(message);
  });
  return (event: unknown) => instance.push(decodeAGUIEvent(event));
}

describe("AG-UI subagent ownership", () => {
  it("accepts interleaved attribution-only messages and inherited tool ownership", () => {
    const push = validator();
    push({ type: "TEXT_MESSAGE_START", messageId: "a", subagentRunId: "one" });
    push({ type: "TEXT_MESSAGE_START", messageId: "b", subagentRunId: "two" });
    push({ type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "hello" });
    push({ type: "TEXT_MESSAGE_CONTENT", messageId: "b", delta: "world", subagentRunId: "two" });
    push({
      type: "TOOL_CALL_START",
      toolCallId: "tool",
      toolCallName: "pick",
      parentMessageId: "a",
    });
    push({ type: "TOOL_CALL_ARGS", toolCallId: "tool", delta: "{}", subagentRunId: "one" });
    expect(() => push({ type: "TOOL_CALL_END", toolCallId: "tool", subagentRunId: "two" })).toThrow(
      "opener",
    );
    expect(() => push({ type: "TEXT_MESSAGE_END", messageId: "a", subagentRunId: "two" })).toThrow(
      "opener",
    );
  });

  it("preserves ownership seeded by snapshots", () => {
    const push = validator();
    push({
      type: "MESSAGES_SNAPSHOT",
      messages: [
        {
          id: "m",
          role: "assistant",
          subagentRunId: "one",
          toolCalls: [{ id: "t", type: "function", function: { name: "pick", arguments: "{}" } }],
        },
      ],
    });
    expect(() =>
      push({
        type: "TOOL_CALL_RESULT",
        messageId: "result",
        toolCallId: "t",
        content: "ok",
        subagentRunId: "two",
      }),
    ).toThrow("opener");
    push({
      type: "ACTIVITY_SNAPSHOT",
      messageId: "activity",
      activityType: "progress",
      content: {},
      subagentRunId: "one",
    });
    expect(() =>
      push({
        type: "ACTIVITY_DELTA",
        messageId: "activity",
        activityType: "progress",
        patch: [],
        subagentRunId: "two",
      }),
    ).toThrow("opener");
  });

  it("requires matching step owners even for steps with the same name", () => {
    const push = validator();
    push({ type: "STEP_STARTED", stepName: "search", subagentRunId: "one" });
    push({ type: "STEP_STARTED", stepName: "search", subagentRunId: "two" });
    expect(() => push({ type: "STEP_FINISHED", stepName: "search" })).toThrow("owner");
    push({ type: "STEP_FINISHED", stepName: "search", subagentRunId: "two" });
    push({ type: "STEP_FINISHED", stepName: "search", subagentRunId: "one" });
  });

  it("requires announced children to close before the run finishes", () => {
    const push = validator();
    push({ type: "SUBAGENT_STARTED", subagentRunId: "one", name: "research" });
    push({
      type: "SUBAGENT_STARTED",
      subagentRunId: "two",
      name: "search",
      parentSubagentRunId: "one",
    });
    expect(() =>
      push({
        type: "RUN_FINISHED",
        threadId: "thread",
        runId: "run",
        outcome: { type: "success" },
      }),
    ).toThrow("active");
    push({ type: "SUBAGENT_ERROR", subagentRunId: "two", message: "failed" });
    push({ type: "TEXT_MESSAGE_START", messageId: "a", subagentRunId: "one" });
    push({ type: "SUBAGENT_FINISHED", subagentRunId: "one", outcome: { type: "success" } });
    push({ type: "RUN_FINISHED", threadId: "thread", runId: "run", outcome: { type: "success" } });
    expect(() =>
      push({ type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "late", subagentRunId: "one" }),
    ).toThrow("closed");
    expect(() => push({ type: "SUBAGENT_STARTED", subagentRunId: "one", name: "again" })).toThrow(
      "twice",
    );
  });

  it("rejects an announcement after attributed output", () => {
    const push = validator();
    push({ type: "TEXT_MESSAGE_START", messageId: "a", subagentRunId: "one" });
    expect(() => push({ type: "SUBAGENT_STARTED", subagentRunId: "one", name: "late" })).toThrow(
      "precede",
    );
  });

  it("rejects missing parents and permits run error to abandon active children", () => {
    const push = validator();
    expect(() =>
      push({
        type: "SUBAGENT_STARTED",
        subagentRunId: "two",
        name: "search",
        parentSubagentRunId: "missing",
      }),
    ).toThrow("parent");
    push({ type: "SUBAGENT_STARTED", subagentRunId: "one", name: "research" });
    push({ type: "RUN_ERROR", message: "run failed" });
  });
});
