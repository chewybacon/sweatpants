import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  ChatProtocolError,
  activityPatchParser,
  aguiEventParser,
  decodeAGUIEvent,
  encodeAGUIEvent,
  publicActivityParser,
} from "../chat-client-codec.ts";

describe("official AG-UI chat codec", () => {
  it("accepts official message, reasoning, raw, and custom events", () => {
    const snapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: "user-1", role: "user" as const, content: "hello" }],
    };
    expect(decodeAGUIEvent(snapshot)).toMatchObject({ type: EventType.MESSAGES_SNAPSHOT });
    expect(aguiEventParser.parse(snapshot)).toEqual({ ok: true, value: snapshot });
    expect(
      decodeAGUIEvent({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "because",
      }),
    ).toMatchObject({ type: EventType.REASONING_MESSAGE_CONTENT });
    expect(
      decodeAGUIEvent({ type: EventType.RAW, event: { provider: "simulator" } }),
    ).toMatchObject({ type: EventType.RAW, event: { provider: "simulator" } });
    expect(
      decodeAGUIEvent({ type: EventType.CUSTOM, name: "diagnostic", value: { ok: true } }),
    ).toMatchObject({ type: EventType.CUSTOM, name: "diagnostic" });
  });

  it("validates structured-output lifecycle events", () => {
    const start = decodeAGUIEvent({
      type: EventType.CUSTOM,
      name: "structured-output.start",
      value: { messageId: "assistant-1" },
    });
    expect(start).toMatchObject({
      type: EventType.CUSTOM,
      name: "structured-output.start",
      value: { messageId: "assistant-1" },
    });

    const complete = decodeAGUIEvent({
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
    expect(JSON.parse(encodeAGUIEvent(complete))).toEqual(complete);
  });

  it.each([
    ["structured-output.start", { value: {} }],
    ["structured-output.start", { value: { messageId: "m", extra: true } }],
    ["structured-output.complete", { value: { object: {}, raw: 4 } }],
    ["structured-output.complete", { value: { object: {}, raw: "{}", extra: true } }],
    ["structured-output.complete", { value: { raw: "{}" } }],
  ] as const)("rejects malformed %s events", (name, fields) => {
    expect(() => decodeAGUIEvent({ type: EventType.CUSTOM, name, ...fields })).toThrow(
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
      expect(() => decodeAGUIEvent(event)).toThrow(ChatProtocolError);
    }
  });

  it("returns result values for public activity and patch validation", () => {
    const activity = {
      version: 1,
      node: {
        nodeId: "node-1",
        parentNodeId: null,
        sequence: 0,
        kind: "activity",
        state: "running",
        presentation: "public",
      },
    };
    expect(publicActivityParser.parse(activity)).toEqual({ ok: true, value: activity });
    expect(
      publicActivityParser.parse({
        ...activity,
        node: { ...activity.node, state: "done" },
      }).ok,
    ).toBe(false);
    expect(
      activityPatchParser.parse([{ op: "replace", path: "/node/state", value: "complete" }]),
    ).toEqual({
      ok: true,
      value: [{ op: "replace", path: "/node/state", value: "complete" }],
    });
    expect(activityPatchParser.parse([{ op: "remove", path: "/node/state" }]).ok).toBe(false);
  });

  it("strictly validates public activity content and mutable patches", () => {
    expect(() =>
      decodeAGUIEvent({
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
      decodeAGUIEvent({
        type: EventType.ACTIVITY_DELTA,
        messageId: "activity-1",
        activityType: "sweatpants:public-execution",
        patch: [{ op: "replace", path: "/node/parentNodeId", value: null }],
      }),
    ).toThrow(/chat_activity_patch_invalid/);

    expect(
      decodeAGUIEvent({
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
      decodeAGUIEvent({
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
      decodeAGUIEvent({
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
    expect(JSON.parse(encodeAGUIEvent(event))).toMatchObject(event);
    expect(() =>
      encodeAGUIEvent({
        type: "THINKING_START",
      } as never),
    ).toThrow(/chat_event_invalid/);
  });
});
