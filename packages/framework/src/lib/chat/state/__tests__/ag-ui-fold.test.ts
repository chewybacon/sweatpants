import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState } from "../reducer.ts";
import type { StreamEvent } from "../../session/streaming.ts";
import { run } from "effection";
import { replayFramesToConversation } from "../../session/durable-history.ts";

function fold(events: StreamEvent[]) {
  return events.reduce(chatReducer, initialChatState);
}

const correlation = { threadId: "thread-1", runId: "run-1" };

describe("canonical AG-UI chat fold", () => {
  it("folds assistant text without an intermediate patch vocabulary", () => {
    const state = fold([
      { type: "RUN_STARTED", ...correlation },
      { type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "hel" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "lo" },
      { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
      { type: "RUN_FINISHED", ...correlation, outcome: { type: "success" } },
    ]);

    expect(state.isStreaming).toBe(false);
    expect(state.messages).toContainEqual({ id: "assistant-1", role: "assistant", content: "hello" });
    expect(state.finalizedParts["assistant-1"]?.[0]).toMatchObject({ type: "text", content: "hello" });
  });

  it("assembles AG-UI tool calls and results directly", () => {
    const state = fold([
      { type: "RUN_STARTED", ...correlation },
      { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "search", parentMessageId: "assistant-tools-1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"query":"hi"}' },
      { type: "TOOL_CALL_END", toolCallId: "call-1" },
      { type: "TOOL_CALL_RESULT", messageId: "tool-1", toolCallId: "call-1", toolCallName: "search", content: "found" },
      { type: "RUN_FINISHED", ...correlation, outcome: { type: "success" } },
    ]);

    expect(state.messages.find((message) => message.id === "assistant-tools-1")?.tool_calls?.[0]).toMatchObject({
      id: "call-1",
      function: { name: "search", arguments: { query: "hi" } },
    });
    expect(state.messages.find((message) => message.id === "tool-1")).toMatchObject({
      role: "tool",
      tool_call_id: "call-1",
      content: "found",
    });
    expect(state.finalizedParts["assistant-tools-1"]?.[0]).toMatchObject({
      type: "tool-call",
      state: "complete",
      result: "found",
    });
  });

  it("projects canonical interrupts into pending client actions", () => {
    const state = fold([
      { type: "RUN_STARTED", ...correlation },
      {
        type: "RUN_FINISHED",
        ...correlation,
        outcome: {
          type: "interrupt",
          interrupts: [{
            id: "approve-1",
            reason: "approval",
            toolCallId: "call-1",
            message: "Approve?",
            responseSchema: { type: "object" },
            metadata: { "sweatpants/toolName": "delete", "sweatpants/key": "approve" },
          }],
        },
      },
    ]);

    expect(state.pendingElicits["call-1"]?.elicitations[0]).toMatchObject({
      elicitId: "approve-1",
      toolName: "delete",
      key: "approve",
      status: "pending",
    });
  });

  it("uses the identical fold for durable replay", async () => {
    const events: StreamEvent[] = [
      { type: "RUN_STARTED", ...correlation },
      { type: "TEXT_MESSAGE_START", messageId: "assistant-1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "replayed" },
      { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
      { type: "RUN_FINISHED", ...correlation, outcome: { type: "success" } },
    ];
    const replay = await run(function* () {
      return yield* replayFramesToConversation(events.map((event, index) => ({ lsn: index + 1, event })));
    });

    expect(replay.events).toEqual(events);
    expect(replay.history).toEqual(fold(events).messages);
  });
});
