import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { decodePublicProjectionRoot } from "../client/conversation-window.ts";
import { projectionFromPublicRoots } from "../client/window-projection.ts";

describe("window projection", () => {
  it("replays placement anchors ancestor-first when child sequence is lower", () => {
    const messageId = "assistant-tool-message";
    const callId = "call-1";
    const messageNodeId = `activity-message:${messageId}`;
    const toolNodeId = `execution:${callId}`;
    const messageRoot = decodePublicProjectionRoot({
      rootId: `message:${messageId}`,
      position: "0",
      kind: "message",
      state: "sealed",
      attribution: {},
      message: {
        id: messageId,
        role: "assistant",
        toolCalls: [
          {
            id: callId,
            type: "function",
            function: { name: "example", arguments: "{}" },
          },
        ],
      },
      placement: { type: "root", sequence: 0 },
    });
    const childEvent = {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: toolNodeId,
      activityType: "sweatpants:public-execution",
      content: {
        version: 1,
        node: {
          nodeId: toolNodeId,
          parentNodeId: messageNodeId,
          sequence: 0,
          kind: "tool-call",
          state: "input-available",
          presentation: "public",
          publicData: {
            kind: "tool-call",
            callId,
            name: "example",
            input: {},
            rawInput: "{}",
          },
        },
      },
      replace: true,
    } as const;
    const activityRoot = decodePublicProjectionRoot({
      rootId: `activity:${toolNodeId}`,
      position: "1",
      kind: "activity-subtree",
      state: "mutable",
      attribution: {},
      rootNodeId: toolNodeId,
      producerSequence: 0,
      anchors: [
        {
          nodeId: messageNodeId,
          parentNodeId: null,
          sequence: 2,
          kind: "message",
          presentation: "public",
          publicData: { kind: "message", messageId, role: "assistant" },
        },
        {
          nodeId: toolNodeId,
          parentNodeId: messageNodeId,
          sequence: 0,
          kind: "tool-call",
          presentation: "public",
          publicData: {
            kind: "tool-call",
            callId,
            name: "example",
            input: {},
            rawInput: "{}",
          },
        },
      ],
      nodes: [{ activityRecordId: toolNodeId, producerSequence: 0, event: childEvent }],
      unloadedDescendantCount: 0,
    });

    const projection = projectionFromPublicRoots([messageRoot, activityRoot]);

    expect(projection.messageNodeById.get(messageId)).toBe(messageNodeId);
    expect(projection.toolNodeByCallId.get(callId)).toBe(toolNodeId);
    expect(projection.nodes.get(toolNodeId)?.node.parentNodeId).toBe(messageNodeId);
  });
});

it("uses a loaded parent result instead of stale data in archived descendant anchors", () => {
  const parent = {
    nodeId: "parent",
    parentNodeId: null,
    sequence: 0,
    kind: "tool-call",
    presentation: "public",
    publicData: { kind: "tool-call", callId: "call", name: "work", input: {} },
  };
  const completed = {
    ...parent,
    state: "output-available",
    publicData: { ...parent.publicData, output: "finished" },
  };
  function root(id: string, position: string, node: unknown, anchors: unknown[]) {
    return decodePublicProjectionRoot({
      rootId: `activity:${id}`,
      position,
      kind: "activity-subtree",
      state: "sealed",
      attribution: {},
      rootNodeId: id,
      producerSequence: 0,
      anchors,
      unloadedDescendantCount: 0,
      nodes: [
        {
          activityRecordId: id,
          producerSequence: 0,
          event: {
            type: "ACTIVITY_SNAPSHOT",
            messageId: id,
            activityType: "sweatpants:public-execution",
            content: { version: 1, node },
            replace: true,
          },
        },
      ],
    });
  }
  const child = (id: string) => ({
    nodeId: id,
    parentNodeId: "parent",
    sequence: id === "early" ? 0 : 1,
    kind: "activity",
    state: "complete",
    presentation: "public",
    publicData: { kind: "activity", activityType: "step" },
  });
  const roots = [
    root("parent", "0", completed, []),
    root("early", "1", child("early"), [parent]),
    root("late", "2", child("late"), [{ ...parent, publicData: completed.publicData }]),
  ];
  const projection = projectionFromPublicRoots(roots);
  expect(projection.nodes.get("parent")?.node).toMatchObject({
    state: "output-available",
    publicData: { output: "finished" },
  });
  expect(() =>
    projectionFromPublicRoots([
      roots[0],
      root("bad", "3", child("bad"), [{ ...parent, sequence: 99 }]),
    ]),
  ).toThrow("conflicts");
});
