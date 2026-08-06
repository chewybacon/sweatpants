import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  ChatProtocolError,
  decodeChatStreamEvent,
  encodeChatStreamEvent,
} from "./chat-client-codec.ts";

describe("official AG-UI chat codec", () => {
  it("accepts official message, reasoning, raw, and custom events", () => {
    expect(
      decodeChatStreamEvent({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [{ id: "user-1", role: "user", content: "hello" }],
      }),
    ).toMatchObject({ type: EventType.MESSAGES_SNAPSHOT });
    expect(
      decodeChatStreamEvent({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "because",
      }),
    ).toMatchObject({ type: EventType.REASONING_MESSAGE_CONTENT });
    expect(
      decodeChatStreamEvent({ type: EventType.RAW, event: { provider: "simulator" } }),
    ).toMatchObject({ type: EventType.RAW, event: { provider: "simulator" } });
    expect(
      decodeChatStreamEvent({ type: EventType.CUSTOM, name: "diagnostic", value: { ok: true } }),
    ).toMatchObject({ type: EventType.CUSTOM, name: "diagnostic" });
  });

  it("validates structured-output lifecycle events", () => {
    const start = decodeChatStreamEvent({
      type: EventType.CUSTOM,
      name: "structured-output.start",
      value: { messageId: "assistant-1" },
    });
    expect(start).toMatchObject({
      type: EventType.CUSTOM,
      name: "structured-output.start",
      value: { messageId: "assistant-1" },
    });

    const complete = decodeChatStreamEvent({
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: {
        messageId: "assistant-1",
        object: { title: "Ada" },
        raw: '{"title":"Ada"}',
        reasoning: "validated output",
      },
    });
    expect(complete).toMatchObject({
      type: EventType.CUSTOM,
      name: "structured-output.complete",
      value: {
        messageId: "assistant-1",
        object: { title: "Ada" },
        raw: '{"title":"Ada"}',
        reasoning: "validated output",
      },
    });
    expect(JSON.parse(encodeChatStreamEvent(complete))).toEqual(complete);
  });

  it.each([
    ["structured-output.start", { value: {} }],
    ["structured-output.start", { value: { messageId: "m", extra: true } }],
    ["structured-output.complete", { value: { object: {}, raw: 4 } }],
    ["structured-output.complete", { value: { object: {}, raw: "{}", extra: true } }],
    ["structured-output.complete", { value: { raw: "{}" } }],
  ] as const)("rejects malformed %s events", (name, fields) => {
    expect(() => decodeChatStreamEvent({ type: EventType.CUSTOM, name, ...fields })).toThrow(
      ChatProtocolError,
    );
  });

  it("rejects deprecated thinking and prototype host-tree events", () => {
    for (const event of [
      { type: "THINKING_START" },
      { type: "THINKING_TEXT_MESSAGE_CONTENT", delta: "old" },
      { type: "HOST_TREE_DELTA", delta: {} },
      { type: "HOST_TREE_SNAPSHOT", snapshot: {} },
      { type: "sweatpants:plugin-replay", content: {} },
    ]) {
      expect(() => decodeChatStreamEvent(event)).toThrow(ChatProtocolError);
    }
  });

  it("strictly validates public activity content and mutable patches", () => {
    expect(() =>
      decodeChatStreamEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "sweatpants:public-execution",
        content: {
          version: 1,
          extra: true,
          node: {
            nodeId: "node-1",
            parentNodeId: null,
            sequence: 0,
            kind: "activity",
            state: "running",
            presentation: "opaque",
            publicData: { kind: "activity", activityType: "opaque-execution" },
          },
        },
      }),
    ).toThrow(/chat_activity_invalid/);

    expect(() =>
      decodeChatStreamEvent({
        type: EventType.ACTIVITY_DELTA,
        messageId: "activity-1",
        activityType: "sweatpants:public-execution",
        patch: [{ op: "replace", path: "/node/parentNodeId", value: null }],
      }),
    ).toThrow(/chat_activity_patch_invalid/);

    expect(
      decodeChatStreamEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "activity-1",
        activityType: "other:activity",
        content: { value: "safe" },
      }),
    ).toMatchObject({ replace: true, activityType: "other:activity" });
  });

  it.each([
    ["message", "pending", { kind: "message", messageId: "m", role: "assistant" }],
    ["tool-call", "running", { kind: "tool-call", callId: "c", name: "tool" }],
    ["activity", "responded", { kind: "activity", activityType: "work" }],
    [
      "elicit",
      "output-available",
      {
        kind: "elicit",
        elicitId: "e",
        bindingId: "b",
        key: "pick",
        message: "Pick",
        responseContract: { identity: "schema", digest: "digest" },
        toolName: "tool",
        callId: "c",
        producerSequence: 0,
      },
    ],
  ])("rejects %s nodes with state %s", (kind, state, publicData) => {
    expect(() =>
      decodeChatStreamEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: `record-${kind}`,
        activityType: "sweatpants:public-execution",
        content: {
          version: 1,
          node: {
            nodeId: `node-${kind}`,
            parentNodeId: null,
            sequence: 0,
            kind,
            state,
            presentation: "public",
            publicData,
          },
        },
      }),
    ).toThrow(/chat_activity_invalid/);
  });

  it("rejects tool lifecycle data that contradicts its state", () => {
    expect(() =>
      decodeChatStreamEvent({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "tool-record",
        activityType: "sweatpants:public-execution",
        content: {
          version: 1,
          node: {
            nodeId: "tool-node",
            parentNodeId: null,
            sequence: 0,
            kind: "tool-call",
            state: "output-available",
            presentation: "public",
            publicData: { kind: "tool-call", callId: "call", name: "tool", input: {} },
          },
        },
      }),
    ).toThrow(/requires input and output/);
  });

  it("revalidates at serialization and never encodes deprecated events", () => {
    const event = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "message-1",
      delta: "hello",
    } as const;
    expect(JSON.parse(encodeChatStreamEvent(event))).toMatchObject(event);
    expect(() =>
      encodeChatStreamEvent({
        type: "THINKING_START",
      } as never),
    ).toThrow(/chat_event_invalid/);
  });
});
