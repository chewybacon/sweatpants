import { describe, expect, it } from "vitest";
import { createChatTurnState } from "../turn-state.ts";
import type { StreamResult } from "../streaming.ts";

function elicitParked(callId: string, elicitId: string): Extract<StreamResult, { type: "elicit" }> {
  return {
    type: "elicit",
    pendingElicitations: [
      {
        type: "elicit_request",
        sessionId: callId,
        callId,
        toolName: "book_flight",
        elicitId,
        key: "seat",
        message: "Pick a seat",
        schema: {},
      },
    ],
    conversationState: {
      messages: [],
      assistantContent: "",
      toolCalls: [{ id: callId, name: "book_flight", arguments: {} }],
      serverToolResults: [],
    },
  };
}

describe("createChatTurnState", () => {
  it("emits the user message and starts each turn from the current history", () => {
    const turn = createChatTurnState();

    const events = turn.send("hello");
    expect(events).toEqual([
      { type: "LOCAL_USER_MESSAGE", message: expect.objectContaining({ content: "hello" }) },
    ]);
    expect(turn.history).toHaveLength(1);

    const request = turn.beginTurnRequest();
    expect(request.originalHistoryLength).toBe(1);
    expect(request.elicitResponses).toEqual([]);
    expect(request.conversationId).toBeUndefined();
  });

  it("captures the server-minted conversation id for later turns", () => {
    const turn = createChatTurnState();
    turn.recordConversationId({ type: "complete", text: "hi", conversationId: "conv-9" });
    expect(turn.conversationId).toBe("conv-9");
    expect(turn.beginTurnRequest().conversationId).toBe("conv-9");
  });

  it("supersedes parked tool calls and open elicits on a new send", () => {
    const turn = createChatTurnState();
    turn.send("book me a flight");
    const request = turn.beginTurnRequest();
    turn.commitElicit(elicitParked("call-1", "elicit-1"), request.originalHistoryLength);

    const events = turn.send("actually never mind");

    // Parked call receives a causal cancellation record in history.
    const cancelled = turn.history.find(
      (message) => message.role === "tool" && message.tool_call_id === "call-1",
    );
    expect(cancelled?.content).toContain("cancelled by user sending a new message");

    // Open elicit is cancelled without resuming tool business logic.
    expect(events).toContainEqual({
      type: "LOCAL_ELICIT_RESPONSE",
      callId: "call-1",
      elicitId: "elicit-1",
      response: { action: "cancel" },
    });
    expect(events.at(-1)).toEqual({
      type: "LOCAL_USER_MESSAGE",
      message: expect.objectContaining({ content: "actually never mind" }),
    });
  });

  it("suppresses duplicate responses for the same elicit id", () => {
    const turn = createChatTurnState();
    turn.send("book me a flight");
    turn.commitElicit(
      elicitParked("call-1", "elicit-1"),
      turn.beginTurnRequest().originalHistoryLength,
    );

    const first = turn.elicitResponse({
      sessionId: "call-1",
      callId: "call-1",
      elicitId: "elicit-1",
      result: { action: "accept", content: { seat: "3A" } },
    });
    expect(first).not.toBeNull();

    const second = turn.elicitResponse({
      sessionId: "call-1",
      callId: "call-1",
      elicitId: "elicit-1",
      result: { action: "accept", content: { seat: "4B" } },
    });
    expect(second).toBeNull();

    // A later send must not re-cancel the already-responded elicit.
    const sendEvents = turn.send("next question");
    expect(sendEvents.filter((event) => event.type === "LOCAL_ELICIT_RESPONSE")).toHaveLength(0);
  });

  it("delivers each queued elicit response to exactly one request", () => {
    const turn = createChatTurnState();
    turn.elicitResponse({
      sessionId: "call-1",
      callId: "call-1",
      elicitId: "elicit-1",
      result: { action: "accept", content: { seat: "3A" } },
    });

    const first = turn.beginTurnRequest();
    expect(first.elicitResponses).toHaveLength(1);
    const second = turn.beginTurnRequest();
    expect(second.elicitResponses).toHaveLength(0);
  });

  it("keeps causal order call -> result -> terminal assistant on complete", () => {
    const turn = createChatTurnState();
    turn.send("run the tool");
    const request = turn.beginTurnRequest();

    // Mirrored fold observed the terminal assistant text before the request
    // result exposed the server tool result.
    turn.fold({
      type: "MESSAGES_SNAPSHOT",
      messages: [
        { id: "user:u1", role: "user", content: "run the tool" },
        {
          id: "assistant:tools:call-1",
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } },
          ],
        },
        { id: "assistant:final:u1", role: "assistant", content: "done" },
      ],
    });

    turn.commitComplete(
      {
        type: "complete",
        text: "done",
        toolResults: [{ id: "call-1", name: "echo", content: "ok" }],
      },
      request.originalHistoryLength,
    );

    const shape = turn.history.map((message) => `${message.role}:${message.tool_call_id ?? ""}`);
    const callIndex = turn.history.findIndex(
      (message) => message.role === "assistant" && message.tool_calls?.length,
    );
    const resultIndex = turn.history.findIndex(
      (message) => message.role === "tool" && message.tool_call_id === "call-1",
    );
    const finalIndex = turn.history.findIndex(
      (message) => message.role === "assistant" && message.content === "done",
    );
    expect(callIndex, shape.join(" | ")).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(finalIndex).toBeGreaterThan(resultIndex);
    // Exactly one terminal assistant projection.
    expect(
      turn.history.filter((message) => message.role === "assistant" && message.content === "done"),
    ).toHaveLength(1);
  });

  it("preserves streamed partial assistant text when a request fails", () => {
    const turn = createChatTurnState();
    turn.send("hello");
    const request = turn.beginTurnRequest();

    turn.fold({ type: "RUN_STARTED", threadId: "t", runId: "r" });
    turn.fold({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" });
    turn.fold({ type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "partial answ" });

    turn.commitFailure(request.originalHistoryLength);

    const partial = turn.history.find(
      (message) => message.role === "assistant" && message.content === "partial answ",
    );
    expect(partial?.partial).toBe(true);
  });

  it("reset clears history, queues, and duplicate-suppression state", () => {
    const turn = createChatTurnState("conv-1");
    turn.send("hello");
    turn.commitElicit(elicitParked("call-1", "elicit-1"), 1);
    turn.elicitResponse({
      sessionId: "call-1",
      callId: "call-1",
      elicitId: "elicit-1",
      result: { action: "cancel" },
    });

    expect(turn.reset()).toEqual([{ type: "LOCAL_RESET" }]);
    expect(turn.history).toHaveLength(0);
    expect(turn.beginTurnRequest().elicitResponses).toEqual([]);

    // The same elicit id is respondable again after reset.
    expect(
      turn.elicitResponse({
        sessionId: "call-1",
        callId: "call-1",
        elicitId: "elicit-1",
        result: { action: "cancel" },
      }),
    ).not.toBeNull();
  });
});
