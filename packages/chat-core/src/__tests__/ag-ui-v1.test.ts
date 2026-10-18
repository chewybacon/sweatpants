import { EventType, PROTOCOL_VERSION } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  createChatProjection,
  decodeAGUIEvent,
  foldAGUIEvent,
  materializeChatMessages,
  projectChatMessagesToAGUI,
} from "../index.ts";
import {
  agUiMessagesToChatHistoryEntries,
  chatHistoryEntriesToAgUiMessages,
} from "../ag-ui/history.ts";

describe("AG-UI 1.0 boundary", () => {
  it("omits absent media metadata when projecting UI messages back onto the wire", () => {
    const snapshot = decodeAGUIEvent({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "media",
          role: "user",
          content: [
            { type: "text", text: "Inspect" },
            {
              type: "image",
              source: { type: "url", value: "https://example.com/image.png" },
              metadata: { detail: "high" },
            },
            { type: "audio", source: { type: "data", value: "YQ==", mimeType: "audio/wav" } },
            { type: "video", source: { type: "url", value: "https://example.com/video.mp4" } },
            {
              type: "document",
              source: { type: "data", value: "YQ==", mimeType: "application/pdf" },
            },
          ],
        },
      ],
    });
    const projection = foldAGUIEvent(createChatProjection(), snapshot);
    const projected = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: projectChatMessagesToAGUI(materializeChatMessages(projection)),
    };
    expect(decodeAGUIEvent(projected)).toEqual(snapshot);
  });

  it("preserves version, usage, and subagent attribution through decoding", () => {
    expect(
      decodeAGUIEvent({
        type: EventType.RUN_STARTED,
        threadId: "thread",
        runId: "run",
        protocolVersion: PROTOCOL_VERSION,
      }),
    ).toMatchObject({ protocolVersion: "1.0" });
    expect(
      decodeAGUIEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity",
        activityType: "progress",
        content: { progress: 1 },
        subagentRunId: "child",
        timestamp: 42,
      }),
    ).toMatchObject({ subagentRunId: "child", timestamp: 42 });
    expect(
      decodeAGUIEvent({
        type: EventType.RUN_FINISHED,
        threadId: "thread",
        runId: "run",
        outcome: { type: "success" },
        usage: [{ inputTokens: 10, outputTokens: 3 }],
      }),
    ).toMatchObject({ usage: [{ inputTokens: 10, outputTokens: 3 }] });
  });

  it("defaults omitted text-message roles to assistant", () => {
    let state = createChatProjection();
    for (const event of [
      { type: EventType.TEXT_MESSAGE_START, messageId: "answer" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "answer", delta: "Hello" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "answer" },
    ]) {
      state = foldAGUIEvent(state, decodeAGUIEvent(event));
    }
    expect(materializeChatMessages(state)).toMatchObject([{ id: "answer", role: "assistant" }]);
  });

  it("round-trips ordered multimodal tool results", () => {
    const messages = [
      {
        id: "assistant",
        role: "assistant" as const,
        toolCalls: [
          { id: "call", type: "function" as const, function: { name: "chart", arguments: "{}" } },
        ],
      },
      {
        id: "result",
        role: "tool" as const,
        toolCallId: "call",
        content: [
          { type: "text" as const, text: "Chart" },
          {
            type: "image" as const,
            source: { type: "url" as const, value: "https://example.com/chart.png" },
          },
        ],
      },
    ];
    expect(chatHistoryEntriesToAgUiMessages(agUiMessagesToChatHistoryEntries(messages))).toEqual(
      messages,
    );
  });

  it("retains subagent attribution through UI materialization and snapshot hydration", () => {
    let state = createChatProjection();
    for (const event of [
      { type: EventType.TEXT_MESSAGE_START, messageId: "child-message", subagentRunId: "child" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "child-message", delta: "hello" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "child-message" },
    ]) {
      state = foldAGUIEvent(state, decodeAGUIEvent(event));
    }
    const messages = materializeChatMessages(state);
    expect(messages).toMatchObject([{ id: "child-message", subagentRunId: "child" }]);
    const snapshot = decodeAGUIEvent({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: projectChatMessagesToAGUI(messages),
    });
    expect(
      projectChatMessagesToAGUI(
        materializeChatMessages(foldAGUIEvent(createChatProjection(), snapshot)),
      ),
    ).toEqual(projectChatMessagesToAGUI(messages));
  });

  it("rejects malformed known events", () => {
    expect(() =>
      decodeAGUIEvent({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "call",
        content: [{ type: "image" }],
      }),
    ).toThrow();
  });
});
