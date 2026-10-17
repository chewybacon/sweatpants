import { expect, it } from "vitest";
import { run } from "effection";
import { decodePublicProjectionRoot } from "@sweatpants/chat-core";
import { assertJson } from "@sweatpants/foundation";
import { enrichPlacementAnchors } from "../placement-anchors.ts";

it("recovers legacy parent positions without rewriting archive records or reading for modern anchors", async () => {
  const parent = {
    rootId: "message:owner",
    position: "11",
    kind: "message",
    state: "sealed",
    attribution: {},
    message: { id: "owner", role: "assistant", content: "Start" },
    placement: { type: "root", sequence: 0 },
  };
  const root = decodePublicProjectionRoot({
    rootId: "activity:child",
    position: "19",
    kind: "activity-subtree",
    state: "sealed",
    attribution: {},
    rootNodeId: "child",
    producerSequence: 0,
    unloadedDescendantCount: 0,
    anchors: [
      {
        nodeId: "owner-node",
        parentNodeId: null,
        sequence: 0,
        kind: "message",
        presentation: "public",
        publicData: { kind: "message", messageId: "owner", role: "assistant" },
      },
    ],
    nodes: [
      {
        activityRecordId: "child",
        producerSequence: 0,
        event: {
          type: "ACTIVITY_SNAPSHOT",
          messageId: "child",
          activityType: "sweatpants:public-execution",
          replace: true,
          content: {
            version: 1,
            node: {
              nodeId: "child",
              parentNodeId: "owner-node",
              sequence: 0,
              kind: "activity",
              state: "complete",
              presentation: "public",
              publicData: { kind: "activity", activityType: "step" },
            },
          },
        },
      },
    ],
  });
  let reads = 0;
  const store = {
    *readPublicHistoryBefore() {
      reads++;
      return { roots: [assertJson(parent)], nextBeforePosition: null };
    },
  };
  const basis = {
    lineageId: "lineage",
    basisRevision: "1",
    archiveFrontierOrdinal: "1",
    nextPublicPosition: "20",
    hotRootPositions: ["19"],
  };
  const enriched = await run(() => enrichPlacementAnchors(store, "conversation", basis, [root]));
  expect(enriched[0]).toMatchObject({ anchors: [{ messagePosition: "11" }] });
  expect(root).toMatchObject({ anchors: [expect.not.objectContaining({ messagePosition: "11" })] });
  expect(await run(() => enrichPlacementAnchors(store, "conversation", basis, enriched))).toEqual(
    enriched,
  );
  expect(reads).toBe(1);
});
