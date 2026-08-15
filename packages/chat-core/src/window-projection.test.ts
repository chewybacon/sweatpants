import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { decodePublicProjectionRoot } from "./conversation-window.ts";
import { projectionFromPublicRoots } from "./window-projection.ts";

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
