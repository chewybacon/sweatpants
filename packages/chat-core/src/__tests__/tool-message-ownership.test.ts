import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  createChatProjection,
  decodeAGUIEvent,
  foldAGUIEvents,
  materializeChatMessages,
  projectChatMessagesToAGUI,
} from "../index.ts";
import { SubagentValidator } from "../client/subagent-validator.ts";

describe("tool-only message ownership", () => {
  it("retains the opener's owner through snapshot hydration and a resumed result", () => {
    const events = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "ask",
        toolCallName: "ask",
        parentMessageId: "parent",
        subagentRunId: "owner",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "ask", delta: "{}" },
      { type: EventType.TOOL_CALL_END, toolCallId: "ask" },
    ].map(decodeAGUIEvent);
    const state = foldAGUIEvents(createChatProjection(), events);
    const messages = projectChatMessagesToAGUI(materializeChatMessages(state));
    expect(messages).toMatchObject([{ id: "parent", subagentRunId: "owner" }]);
    const snapshot = decodeAGUIEvent({ type: EventType.MESSAGES_SNAPSHOT, messages });
    expect(
      projectChatMessagesToAGUI(
        materializeChatMessages(foldAGUIEvents(createChatProjection(), [snapshot])),
      ),
    ).toEqual(messages);

    const validator = new SubagentValidator((message) => {
      throw new Error(message);
    });
    validator.push(snapshot);
    const result = decodeAGUIEvent({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "ask",
      messageId: "result",
      content: "reply",
      role: "tool",
      subagentRunId: "owner",
    });
    expect(() => validator.push(result)).not.toThrow();
    // Snapshot preservation must not weaken ownership validation.
    expect(() =>
      validator.push(decodeAGUIEvent({ ...result, subagentRunId: "wrong-owner" })),
    ).toThrow("subagent attribution disagrees");
  });

  it("keeps sibling owners separate and leaves root tool calls untagged", () => {
    const events = [
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "a",
        toolCallName: "ask",
        parentMessageId: "message-a",
        subagentRunId: "owner-a",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "b",
        toolCallName: "ask",
        parentMessageId: "message-b",
        subagentRunId: "owner-b",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "root",
        toolCallName: "ask",
        parentMessageId: "message-root",
      },
    ].map(decodeAGUIEvent);
    const messages = materializeChatMessages(foldAGUIEvents(createChatProjection(), events));
    expect(messages.map(({ id, subagentRunId }) => ({ id, subagentRunId }))).toEqual([
      { id: "message-a", subagentRunId: "owner-a" },
      { id: "message-b", subagentRunId: "owner-b" },
      { id: "message-root", subagentRunId: undefined },
    ]);
  });

  it.each([true, false])(
    "retains an existing message owner with explicit parent = %s",
    (explicit) => {
      const events = [
        { type: EventType.TEXT_MESSAGE_START, messageId: "parent", subagentRunId: "owner" },
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: "ask",
          toolCallName: "ask",
          ...(explicit ? { parentMessageId: "parent" } : {}),
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "ask", delta: "{}" },
        { type: EventType.TOOL_CALL_END, toolCallId: "ask" },
      ].map(decodeAGUIEvent);
      expect(
        projectChatMessagesToAGUI(
          materializeChatMessages(foldAGUIEvents(createChatProjection(), events)),
        ),
      ).toMatchObject([{ id: "parent", subagentRunId: "owner", toolCalls: [{ id: "ask" }] }]);
    },
  );
});
