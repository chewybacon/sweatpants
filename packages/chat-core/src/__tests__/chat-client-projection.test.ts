import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  ChatProjectionError,
  appendAGUIMessage,
  decodePublicActivity,
  createChatProjection,
  decodeAGUIEvent,
  foldAGUIEvent,
  materializeChatMessages,
  projectChatMessagesToAGUI,
  transitionChatProjection,
} from "../index.ts";

function activity(input: {
  messageId: string;
  nodeId: string;
  parentNodeId: string | null;
  sequence: number;
  kind: "message" | "tool-call" | "activity";
  state: string;
  publicData?: Record<string, unknown>;
}) {
  return decodeAGUIEvent({
    type: "ACTIVITY_SNAPSHOT",
    messageId: input.messageId,
    activityType: "sweatpants:public-execution",
    content: {
      version: 1,
      node: {
        nodeId: input.nodeId,
        parentNodeId: input.parentNodeId,
        sequence: input.sequence,
        kind: input.kind,
        state: input.state,
        presentation: input.kind === "activity" ? "opaque" : "public",
        ...(input.publicData ? { publicData: input.publicData } : {}),
      },
    },
  });
}

describe("headless nested projection", () => {
  it.each([
    { state: "output-error", errorText: "Tool outcome is unknown after interruption" },
    { state: "output-available", output: { booked: true } },
  ])("retains $state when input completion replays after a checkpoint", (outcome) => {
    let state = foldAGUIEvent(createChatProjection(), {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "booking",
      role: "assistant",
    });
    const { state: terminalState, ...result } = outcome;
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "booking-tool",
        nodeId: "execution:booking-call",
        parentNodeId: "message:booking",
        sequence: 0,
        kind: "tool-call",
        state: terminalState,
        publicData: {
          kind: "tool-call",
          callId: "booking-call",
          name: "book_flight",
          input: {},
          rawInput: "{}",
          ...result,
        },
      }),
    );
    const before = materializeChatMessages(state);
    state = foldAGUIEvent(state, { type: EventType.TOOL_CALL_END, toolCallId: "booking-call" });
    expect(materializeChatMessages(state)).toEqual(before);

    // A later accepted result replaces, rather than merges with, the prior outcome.
    for (const failed of [false, true]) {
      const eventResult = foldAGUIEvent(state, {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "booking-call",
        messageId: "booking-result",
        content: JSON.stringify(
          failed ? { status: "error", errorText: "Booking failed" } : { booked: true },
        ),
      });
      const messageResult = appendAGUIMessage(state, {
        id: "booking-result",
        role: "tool",
        toolCallId: "booking-call",
        content: JSON.stringify({ booked: true }),
        ...(failed ? { error: "Booking failed" } : {}),
      });
      for (const projected of [eventResult, messageResult]) {
        const node = projected.nodes.get("execution:booking-call")!.node;
        expect(node.state).toBe(failed ? "output-error" : "output-available");
        expect(() => decodePublicActivity({ version: 1, node })).not.toThrow();
        expect(node.publicData).not.toHaveProperty(failed ? "output" : "errorText");
      }
    }
  });

  it("replaces the server-derived base when a complete message snapshot arrives", () => {
    let state = createChatProjection();
    state = foldAGUIEvent(state, {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "assistant-live", role: "assistant", content: "same answer" }],
    });
    state = foldAGUIEvent(state, {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "assistant-snapshot", role: "assistant", content: "same answer" }],
    });

    expect(materializeChatMessages(state).map((message) => message.id)).toEqual([
      "assistant-snapshot",
    ]);
  });

  it("preserves chronological root message order when turn-local sequences repeat", () => {
    let state = createChatProjection();
    for (const messageId of ["user-1", "assistant-1", "user-2", "assistant-2"]) {
      state = foldAGUIEvent(
        state,
        activity({
          messageId: `record:${messageId}`,
          nodeId: `node:${messageId}`,
          parentNodeId: null,
          sequence: 0,
          kind: "message",
          state: "streaming",
          publicData: {
            kind: "message",
            messageId,
            role: messageId.startsWith("user") ? "user" : "assistant",
          },
        }),
      );
    }
    expect(materializeChatMessages(state).map((message) => message.id)).toEqual([
      "user-1",
      "assistant-1",
      "user-2",
      "assistant-2",
    ]);
  });

  it("preserves a settled tool result when placement activity follows a history snapshot", () => {
    let state = createChatProjection();
    state = foldAGUIEvent(
      state,
      decodeAGUIEvent({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "assistant",
            role: "assistant",
            toolCalls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          {
            id: "tool-result",
            role: "tool",
            toolCallId: "call-1",
            content: '{"answer":42}',
          },
        ],
      }),
    );
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "execution:call-1",
        nodeId: "execution:call-1",
        parentNodeId: "message:assistant",
        sequence: 0,
        kind: "tool-call",
        state: "input-available",
        publicData: {
          kind: "tool-call",
          callId: "call-1",
          name: "lookup",
          input: {},
          rawInput: "{}",
        },
      }),
    );

    const wire = projectChatMessagesToAGUI(materializeChatMessages(state));
    expect(wire).toContainEqual(
      expect.objectContaining({
        role: "tool",
        toolCallId: "call-1",
        name: "lookup",
        content: '{"answer":42}',
        isError: false,
      }),
    );
  });

  it.each([
    {
      content: { status: "ok", output: { answer: 42 } },
      expected: { state: "output-available", output: { answer: 42 } },
    },
    {
      content: { status: "error", errorText: "lookup failed" },
      expected: { state: "output-error", errorText: "lookup failed" },
    },
  ])(
    "keeps $expected.state through repeated placement snapshots and deltas",
    ({ content, expected }) => {
      let state = foldAGUIEvent(createChatProjection(), {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "lookup",
        parentMessageId: "assistant",
      });
      const placement = activity({
        messageId: "execution:call-1",
        nodeId: "execution:call-1",
        parentNodeId: "message:assistant",
        sequence: 0,
        kind: "tool-call",
        state: "input-available",
        publicData: {
          kind: "tool-call",
          callId: "call-1",
          name: "lookup",
          input: {},
          rawInput: "{}",
        },
      });
      state = foldAGUIEvent(state, placement);
      state = foldAGUIEvent(state, {
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: "call-1",
        messageId: "tool-result",
        role: "tool",
        content: JSON.stringify(content),
      });
      expect(materializeChatMessages(state)[0]?.parts[0]).toMatchObject(expected);
      state = foldAGUIEvent(state, placement);
      expect(materializeChatMessages(state)[0]?.parts[0]).toMatchObject(expected);
      state = foldAGUIEvent(
        state,
        decodeAGUIEvent({
          type: EventType.ACTIVITY_DELTA,
          messageId: "execution:call-1",
          activityType: "sweatpants:public-execution",
          patch: [
            { op: "replace", path: "/node/state", value: "input-available" },
            {
              op: "remove",
              path:
                content.status === "ok" ? "/node/publicData/output" : "/node/publicData/errorText",
            },
          ],
        }),
      );
      expect(materializeChatMessages(state)[0]?.parts[0]).toMatchObject(expected);
    },
  );

  it("attaches a generic activity without changing its parent message role", () => {
    let state = foldAGUIEvent(createChatProjection(), {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "user", role: "user", content: "hello" }],
    });
    state = foldAGUIEvent(
      state,
      decodeAGUIEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "progress",
        activityType: "progress",
        content: { done: 1 },
      }),
    );
    expect(materializeChatMessages(state)).toMatchObject([
      {
        id: "user",
        role: "user",
        parts: [
          { type: "text", text: "hello" },
          { type: "activity", activityType: "progress", data: { done: 1 } },
        ],
      },
    ]);
  });

  it("returns client-local actions beside the pure projection", () => {
    const started = foldAGUIEvent(createChatProjection(), {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant",
      role: "assistant",
    });
    const transition = transitionChatProjection(started, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant",
      delta: "hello",
    });
    expect(transition.actions).toEqual([
      {
        type: "text-changed",
        messageId: "assistant",
        kind: "text",
        delta: "hello",
        done: false,
      },
    ]);
    expect(materializeChatMessages(transition.projection)[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "hello",
    });
  });

  it("projects structured output deltas into one typed message part", () => {
    let state = createChatProjection();
    state = foldAGUIEvent(
      state,
      decodeAGUIEvent({
        type: EventType.CUSTOM,
        name: "structured-output.start",
        value: { messageId: "assistant-structured" },
      }),
    );
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "assistant-structured",
      role: "assistant",
    });
    expect(materializeChatMessages(state)[0]?.parts).toHaveLength(1);
    const delta = decodeAGUIEvent({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-structured",
      delta: '{"title":"Ada",',
    });
    const transition = transitionChatProjection(state, delta);
    expect(transition.actions).toEqual([]);
    state = transition.projection;
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-structured",
      delta: '"count": 1}',
    });

    const streaming = materializeChatMessages(state)[0]?.parts[0];
    expect(streaming).toMatchObject({
      type: "structured-output",
      status: "streaming",
      raw: '{"title":"Ada","count": 1}',
      partial: { title: "Ada", count: 1 },
    });

    state = foldAGUIEvent(
      state,
      decodeAGUIEvent({
        type: EventType.CUSTOM,
        name: "structured-output.complete",
        value: {
          messageId: "assistant-structured",
          object: { title: "Ada", count: 1 },
          raw: '{"title":"Ada","count": 1}',
        },
      }),
    );
    expect(materializeChatMessages(state)[0]?.parts[0]).toEqual({
      type: "structured-output",
      id: "assistant-structured:structured-output:2",
      status: "complete",
      raw: '{"title":"Ada","count": 1}',
      partial: { title: "Ada", count: 1 },
      data: { title: "Ada", count: 1 },
    });
  });

  it("retains structured output parts across assistant turns", () => {
    let state = createChatProjection();
    for (const [messageId, title] of [
      ["assistant-1", "first"],
      ["assistant-2", "second"],
    ] as const) {
      state = foldAGUIEvent(
        state,
        decodeAGUIEvent({
          type: EventType.CUSTOM,
          name: "structured-output.start",
          value: { messageId },
        }),
      );
      state = foldAGUIEvent(
        state,
        decodeAGUIEvent({
          type: EventType.CUSTOM,
          name: "structured-output.complete",
          value: {
            messageId,
            object: { title },
            raw: JSON.stringify({ title }),
          },
        }),
      );
    }
    expect(materializeChatMessages(state).map((message) => message.id)).toEqual([
      "assistant-1",
      "assistant-2",
    ]);
    expect(materializeChatMessages(state).map((message) => message.parts[0])).toMatchObject([
      { type: "structured-output", data: { title: "first" } },
      { type: "structured-output", data: { title: "second" } },
    ]);
  });

  it("marks an incomplete structured output as an error at run termination", () => {
    let state = foldAGUIEvent(
      createChatProjection(),
      decodeAGUIEvent({
        type: EventType.CUSTOM,
        name: "structured-output.start",
        value: { messageId: "assistant-error" },
      }),
    );
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-error",
      delta: '{"title":"truncated"',
    });
    state = foldAGUIEvent(
      state,
      decodeAGUIEvent({
        type: EventType.RUN_FINISHED,
        threadId: "thread",
        runId: "run",
        outcome: { type: "success" },
      }),
    );
    expect(materializeChatMessages(state)[0]?.parts[0]).toMatchObject({
      type: "structured-output",
      status: "error",
      raw: '{"title":"truncated"',
      errorText: "Structured output stream ended before completion",
    });
  });

  it("includes structured output raw JSON in provider history", () => {
    let state = foldAGUIEvent(
      createChatProjection(),
      decodeAGUIEvent({
        type: EventType.CUSTOM,
        name: "structured-output.complete",
        value: {
          messageId: "assistant-history",
          object: { title: "history" },
          raw: '{"title":"history"}',
        },
      }),
    );
    const messages = materializeChatMessages(state);
    expect(messages[0]?.parts[0]?.type).toBe("structured-output");
    expect(messages[0] && projectChatMessagesToAGUI(messages)[0]).toMatchObject({
      role: "assistant",
      content: '{"title":"history"}',
    });
  });

  it("buffers child placement and materializes Option B nested messages", () => {
    let state = createChatProjection();
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "nested-message-record",
        nodeId: "nested-message",
        parentNodeId: "tool-node",
        sequence: 2,
        kind: "message",
        state: "streaming",
        publicData: { kind: "message", messageId: "nested-message", role: "assistant" },
      }),
    );
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "root-message-record",
        nodeId: "root-message",
        parentNodeId: null,
        sequence: 0,
        kind: "message",
        state: "streaming",
        publicData: { kind: "message", messageId: "root-message", role: "assistant" },
      }),
    );
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "tool-record",
        nodeId: "tool-node",
        parentNodeId: "root-message",
        sequence: 1,
        kind: "tool-call",
        state: "input-available",
        publicData: { kind: "tool-call", callId: "call-1", name: "delegate", input: {} },
      }),
    );
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "nested-message",
      role: "assistant",
    });
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "nested-message",
      delta: "private-safe result",
    });
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_END,
      messageId: "nested-message",
    });

    const messages = materializeChatMessages(state);
    expect(messages).toHaveLength(1);
    const tool = messages[0]!.parts[0]!;
    expect(tool.type).toBe("tool-call");
    if (tool.type !== "tool-call") {
      throw new Error("expected tool call");
    }
    expect(tool.parts).toHaveLength(1);
    const nested = tool.parts[0]!;
    expect(nested.type).toBe("message");
    if (nested.type !== "message") {
      throw new Error("expected nested message");
    }
    expect(nested.message.id).toBe("nested-message");
    expect(nested.message.role).toBe("assistant");
    expect(nested.message.parts[0]).toMatchObject({
      type: "text",
      text: "private-safe result",
      state: "done",
    });
  });

  it("keeps provisional message children when authoritative placement arrives", () => {
    let state = createChatProjection();
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "root-record",
        nodeId: "root",
        parentNodeId: null,
        sequence: 0,
        kind: "message",
        state: "streaming",
        publicData: { kind: "message", messageId: "root", role: "assistant" },
      }),
    );
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "delegate-record",
        nodeId: "delegate",
        parentNodeId: "root",
        sequence: 0,
        kind: "tool-call",
        state: "input-available",
        publicData: { kind: "tool-call", callId: "delegate-call", name: "delegate", input: {} },
      }),
    );
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "nested",
      role: "assistant",
    });
    state = foldAGUIEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "nested",
      delta: "working",
    });
    state = foldAGUIEvent(state, {
      type: EventType.TOOL_CALL_START,
      toolCallId: "nested-tool-call",
      toolCallName: "nested-tool",
      parentMessageId: "nested",
    });
    state = foldAGUIEvent(state, {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "nested-tool-call",
      delta: "{}",
    });
    state = foldAGUIEvent(state, {
      type: EventType.TOOL_CALL_END,
      toolCallId: "nested-tool-call",
    });
    state = foldAGUIEvent(
      state,
      activity({
        messageId: "nested-record",
        nodeId: "nested-placement",
        parentNodeId: "delegate",
        sequence: 0,
        kind: "message",
        state: "streaming",
        publicData: { kind: "message", messageId: "nested", role: "assistant" },
      }),
    );

    const messages = materializeChatMessages(state);
    expect(messages.map((message) => message.id)).toEqual(["root"]);
    const delegate = messages[0]!.parts[0];
    expect(delegate?.type).toBe("tool-call");
    if (delegate?.type !== "tool-call") {
      throw new Error("expected delegate tool call");
    }
    const nested = delegate.parts[0];
    expect(nested?.type).toBe("message");
    if (nested?.type !== "message") {
      throw new Error("expected nested message");
    }
    expect(nested.message.parts.map((part) => part.type)).toEqual(["text", "tool-call"]);
  });

  it("is idempotent and rejects immutable conflicts", () => {
    const event = activity({
      messageId: "record",
      nodeId: "node",
      parentNodeId: null,
      sequence: 0,
      kind: "message",
      state: "streaming",
      publicData: { kind: "message", messageId: "message", role: "assistant" },
    });
    let state = foldAGUIEvent(createChatProjection(), event);
    state = foldAGUIEvent(state, event);
    expect(materializeChatMessages(state)).toHaveLength(1);
    expect(() =>
      foldAGUIEvent(
        state,
        activity({
          ...event,
          messageId: "record-2",
          nodeId: "node",
          parentNodeId: "different-parent",
          sequence: 4,
          kind: "message",
          state: "done",
          publicData: { kind: "message", messageId: "other", role: "assistant" },
        }),
      ),
    ).toThrowError(ChatProjectionError);
  });

  it("applies only mutable activity patches", () => {
    let state = foldAGUIEvent(
      createChatProjection(),
      activity({
        messageId: "activity-record",
        nodeId: "activity-node",
        parentNodeId: null,
        sequence: 0,
        kind: "activity",
        state: "running",
        publicData: { kind: "activity", activityType: "opaque-execution" },
      }),
    );
    state = foldAGUIEvent(
      state,
      decodeAGUIEvent({
        type: "ACTIVITY_DELTA",
        messageId: "activity-record",
        activityType: "sweatpants:public-execution",
        patch: [{ op: "replace", path: "/node/state", value: "complete" }],
      }),
    );
    expect(materializeChatMessages(state)).toEqual([]);
    expect(() =>
      decodeAGUIEvent({
        type: "ACTIVITY_DELTA",
        messageId: "activity-record",
        activityType: "sweatpants:public-execution",
        patch: [{ op: "replace", path: "/node/parentNodeId", value: null }],
      }),
    ).toThrow(/chat_activity_patch_invalid/);
  });
});
