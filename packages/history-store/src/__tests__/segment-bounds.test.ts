import { DURABLE_SCAN_MAX_BYTES } from "@sweatpants/durable-storage-kernel";
import { canonicalDigest } from "@sweatpants/foundation";
import { expect, it } from "vitest";
import { prepareTerminalSegment } from "../persistence.ts";

it("admits a terminal payload at the limit and rejects larger payloads before publication", () => {
  const entries = ["x".repeat(DURABLE_SCAN_MAX_BYTES - 4)];
  const segment = {
    segmentId: "terminal",
    conversationId: "conversation",
    logicalTurnId: "turn",
    executionId: "execution",
    publicationKey: "publication",
    previous: null,
    firstPosition: "0",
    lastPosition: "0",
    entries,
    contentHash: canonicalDigest(entries),
    createdAt: 1,
  };
  expect(prepareTerminalSegment(segment)).toBe(segment);
  expect(() => prepareTerminalSegment({ ...segment, entries: [`${entries[0]}x`] })).toThrow(
    expect.objectContaining({ code: "segment_entry_too_large" }),
  );
});
