import { describe, expect, it } from "vitest";
import type { JournalRecord, Json } from "@sweatpants/session-contract";

import {
  projectCrankEventToAgUi,
  repairToolHistory,
  toRuntimeMessage,
} from "../session-contract-adapter.ts";
import type { SessionContractChatEngineParams } from "../types.ts";

function params(): SessionContractChatEngineParams {
  return {
    messages: [{ id: "user-1", role: "user", content: "hello" }],
    agUiRun: { threadId: "thread-1", runId: "run-1" },
  } as unknown as SessionContractChatEngineParams;
}

describe("replay-crank AG-UI projection", () => {
  it("rolls an abandoned text attempt back with a snapshot before replacement output", () => {
    const projected = projectCrankEventToAgUi(
      { type: "attempt_abandoned", attemptId: "pull:0:attempt-0", messageId: "pull:0" },
      params(),
      true,
      new Map(),
    );

    expect(projected).toEqual([
      { type: "TEXT_MESSAGE_END", messageId: "assistant:final:run-1" },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "user-1", role: "user", content: "hello" }],
      },
    ]);
    expect(projected.some((event) => event.type === "RUN_ERROR")).toBe(false);
  });

  it("keeps AG-UI text lifecycle IDs consistent while durable IDs remain private", () => {
    const start = projectCrankEventToAgUi(
      { type: "text_started", messageId: "pull:0", attemptId: "attempt-0" },
      params(),
      false,
      new Map(),
    );
    const delta = projectCrankEventToAgUi(
      { type: "text_delta", messageId: "pull:0", attemptId: "attempt-0", delta: "hi" },
      params(),
      true,
      new Map(),
    );

    expect(start).toEqual([
      { type: "TEXT_MESSAGE_START", messageId: "assistant:final:run-1", role: "assistant" },
    ]);
    expect(delta).toEqual([
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant:final:run-1", delta: "hi" },
    ]);
  });
});

describe("replay-crank model history", () => {
  it("repairs an orphaned tool result from the durable child-task record", () => {
    const messages = [
      { role: "user", content: "play" },
      { role: "tool", tool_call_id: "call-1", content: { winner: "X" } },
      { role: "user", content: "who won?" },
    ] as Json[];
    const journal = [
      {
        payload: {
          type: "task_opened",
          input: { callId: "call-1", target: "play_ttt", input: { difficulty: "hard" } },
        },
      },
    ] as unknown as JournalRecord[];

    expect(repairToolHistory(messages, journal)).toEqual([
      { role: "user", content: "play" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", target: "play_ttt", input: { difficulty: "hard" } }],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        tool_name: "play_ttt",
        content: { winner: "X" },
      },
      { role: "user", content: "who won?" },
    ]);
    expect(messages[1]).not.toHaveProperty("tool_name");
  });

  it("preserves nested OpenAI-style function calls and parses JSON arguments", () => {
    expect(
      toRuntimeMessage({
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call-2",
            type: "function",
            function: { name: "book_flight", arguments: '{"from":"NYC","to":"LAX"}' },
          },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-2",
          name: "book_flight",
          arguments: { from: "NYC", to: "LAX" },
        },
      ],
    });
  });

  it("preserves the tool name and unwraps tool-result content", () => {
    expect(
      toRuntimeMessage({
        role: "tool",
        tool_call_id: "call-2",
        tool_name: "book_flight",
        content: { confirmation: "TKT-123" },
      }),
    ).toEqual({
      role: "toolResult",
      toolCallId: "call-2",
      toolName: "book_flight",
      content: [{ type: "text", text: '{"confirmation":"TKT-123"}' }],
      isError: false,
    });
  });
});
