import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import {
  ConversationWindowError,
  compareDurablePositions,
  decodeConversationWindow,
  decodePublicHistoryCursorPayload,
  decodePublicProjectionRoot,
} from "../conversation-window.ts";

const messageRoot = {
  rootId: "root-1",
  position: "10",
  kind: "message",
  state: "sealed",
  attribution: { participantId: "participant-1" },
  logicalTurnId: "turn-1",
  executionId: "execution-1",
  message: { id: "message-1", role: "user", content: "hello" },
  placement: { type: "root", sequence: 0 },
} as const;

function windowValue() {
  return {
    type: "sweatpants.conversation-window.v1",
    conversationId: "conversation-1",
    lineageId: "lineage-1",
    basisRevision: "3",
    windowToken: "opaque-token",
    windowMode: "reset",
    archiveFrontierOrdinal: "4",
    nextPublicPosition: "11",
    hotRoots: [messageRoot],
    sealedCatchupRoots: [],
    applicationState: { status: "ready" },
    olderHistoryCursor: "opaque-cursor",
  };
}

describe("ConversationWindow codec", () => {
  it("round-trips a strict message root and complete window", () => {
    expect(decodePublicProjectionRoot(messageRoot)).toEqual(messageRoot);
    expect(decodeConversationWindow(windowValue())).toEqual(windowValue());
  });

  it("rejects unknown fields and noncanonical positions", () => {
    expect(() => decodeConversationWindow({ ...windowValue(), checkpointId: "private" })).toThrow(
      ConversationWindowError,
    );
    expect(() => decodePublicProjectionRoot({ ...messageRoot, position: "010" })).toThrow(
      /canonical/,
    );
  });

  it("orders durable positions numerically above safe integer range", () => {
    expect(compareDurablePositions("9", "10")).toBe(-1);
    expect(compareDurablePositions("9007199254740992", "9007199254740993")).toBe(-1);
  });

  it("validates self-contained cursor basis invariants", () => {
    const basis = {
      lineageId: "lineage-1",
      basisRevision: "3",
      archiveFrontierOrdinal: "4",
      nextPublicPosition: "11",
      hotRootPositions: ["9", "10"],
      issuedAt: 100,
      expiresAt: 200,
      beforePosition: "11",
    };
    expect(decodePublicHistoryCursorPayload(basis)).toEqual(basis);
    expect(() =>
      decodePublicHistoryCursorPayload({ ...basis, hotRootPositions: ["10", "9"] }),
    ).toThrow(/sorted/);
    expect(() => decodePublicHistoryCursorPayload({ ...basis, expiresAt: 100 })).toThrow(/greater/);
  });

  it("accepts one latest activity snapshot per node", () => {
    const event = {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-root",
      activityType: "sweatpants:public-execution",
      content: {
        version: 1,
        node: {
          nodeId: "node-1",
          parentNodeId: null,
          sequence: 0,
          kind: "activity",
          state: "complete",
          presentation: "public",
          publicData: { kind: "activity", activityType: "example" },
        },
      },
      replace: true,
    };
    expect(
      decodePublicProjectionRoot({
        rootId: "activity-root",
        position: "0",
        kind: "activity-subtree",
        state: "sealed",
        attribution: {},
        rootNodeId: "node-1",
        producerSequence: 1,
        anchors: [],
        nodes: [{ activityRecordId: "record-1", producerSequence: 1, event }],
        unloadedDescendantCount: 2,
      }),
    ).toMatchObject({ kind: "activity-subtree", unloadedDescendantCount: 2 });
  });
});
