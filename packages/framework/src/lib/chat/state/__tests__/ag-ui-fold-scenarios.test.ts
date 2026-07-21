import { describe, expect, it } from "vitest";
import type { ChatStateEvent } from "../events.ts";
import { chatReducer, initialChatState } from "../reducer.ts";

function fold(events: ChatStateEvent[]) {
  return events.reduce(chatReducer, initialChatState);
}

const run = { threadId: "thread", runId: "run" };
const pendingAction = {
  toolCallId: "call-1",
  toolName: "book",
  kind: "elicit" as const,
  sessionId: "session-1",
  elicitId: "elicit-1",
  key: "confirm",
  message: "Confirm?",
  schema: { type: "object" },
};

describe("AG-UI fold scenarios", () => {
  it("tolerates text content when START was lost", () => {
    const state = fold([
      { type: "RUN_STARTED", ...run },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "hello" },
      { type: "TEXT_MESSAGE_END", messageId: "assistant-1" },
      { type: "RUN_FINISHED", ...run },
    ]);
    expect(state.messages.at(-1)).toMatchObject({ id: "assistant-1", content: "hello" });
  });

  it("does not commit or duplicate a running tool host", () => {
    const state = fold([
      { type: "RUN_STARTED", ...run },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-1",
        toolCallName: "one",
        parentMessageId: "host",
      },
    ]);
    expect(state.messages).toHaveLength(0);
    expect(state.streaming.parts).toHaveLength(1);
  });

  it("keeps parallel tool parts until every sibling ends", () => {
    const beforeSecondEnd = fold([
      { type: "RUN_STARTED", ...run },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-1",
        toolCallName: "one",
        parentMessageId: "host",
      },
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-2",
        toolCallName: "two",
        parentMessageId: "host",
      },
      { type: "TOOL_CALL_END", toolCallId: "call-1" },
    ]);
    expect(beforeSecondEnd.streaming.parts).toHaveLength(2);
    expect(beforeSecondEnd.messages).toHaveLength(0);

    const complete = chatReducer(beforeSecondEnd, { type: "TOOL_CALL_END", toolCallId: "call-2" });
    expect(complete.streaming.parts).toHaveLength(0);
    expect(complete.messages).toHaveLength(1);
    expect(complete.messages[0]?.tool_calls?.map((call) => call.id)).toEqual(["call-1", "call-2"]);
    expect(complete.finalizedParts.host).toHaveLength(2);
  });

  it("suppresses duplicate results for the same tool call", () => {
    const state = fold([
      { type: "TOOL_CALL_RESULT", messageId: "tool-old", toolCallId: "call-1", content: "old" },
      { type: "TOOL_CALL_RESULT", messageId: "tool-new", toolCallId: "call-1", content: "new" },
    ]);
    expect(state.messages.filter((message) => message.role === "tool")).toEqual([
      expect.objectContaining({ id: "tool-new", content: "new" }),
    ]);
  });

  it("preserves a local elicit response across a stale snapshot", () => {
    const pending = fold([
      { type: "STATE_SNAPSHOT", snapshot: { pendingClientActions: [pendingAction] } },
    ]);
    const responded = chatReducer(pending, {
      type: "LOCAL_ELICIT_RESPONSE",
      callId: "call-1",
      elicitId: "elicit-1",
      response: { approved: true },
    });
    const staleSnapshot = chatReducer(responded, {
      type: "STATE_SNAPSHOT",
      snapshot: { pendingClientActions: [pendingAction] },
    });
    expect(staleSnapshot.pendingElicits["call-1"]?.elicitations[0]).toMatchObject({
      status: "responded",
      response: { approved: true },
    });
  });

  it("clears an elicit when the authoritative snapshot removes it", () => {
    const pending = fold([
      { type: "STATE_SNAPSHOT", snapshot: { pendingClientActions: [pendingAction] } },
    ]);
    const cleared = chatReducer(pending, { type: "STATE_SNAPSHOT", snapshot: {} });
    expect(cleared.pendingElicits).toEqual({});
  });

  it("updates plugin elicitation state stored on tool parts", () => {
    const state = fold([
      { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "book" },
      { type: "STATE_SNAPSHOT", snapshot: { pendingClientActions: [pendingAction] } },
      {
        type: "LOCAL_ELICIT_RESPONSE",
        callId: "call-1",
        elicitId: "elicit-1",
        response: "yes",
      },
    ]);
    expect(state.streaming.parts[0]).toMatchObject({
      type: "tool-call",
      pluginElicits: [{ id: "elicit-1", status: "responded", response: "yes" }],
    });
  });

  it("folds RUN_ERROR without completing the run as success", () => {
    const state = fold([
      { type: "RUN_STARTED", ...run },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "assistant-1", delta: "partial" },
      { type: "RUN_ERROR", message: "failed" },
    ]);
    expect(state).toMatchObject({ isStreaming: false, error: "failed", activeRun: null });
    expect(state.messages).toHaveLength(0);
  });

  it("preserves locally rendered parts when a matching snapshot arrives", () => {
    const rendered = [
      {
        id: "assistant-1:text",
        type: "text" as const,
        content: "**hi**",
        rendered: "<strong>hi</strong>",
      },
    ];
    const state = fold([
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "assistant-1", role: "assistant", content: "**hi**" }],
      },
      { type: "LOCAL_FINALIZED_PARTS", messageId: "assistant-1", parts: rendered },
      {
        type: "MESSAGES_SNAPSHOT",
        messages: [{ id: "assistant-1", role: "assistant", content: "**hi**" }],
      },
    ]);
    expect(state.finalizedParts["assistant-1"]).toEqual(rendered);
  });
});
