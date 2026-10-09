import { expect, it } from "vitest";
import { preparePrivateSegment } from "../store/store-persistence.ts";

it("rejects a private segment whose individually legal entries exceed the aggregate payload bound", () => {
  const entries = Array.from({ length: 17 }, () => "x".repeat(1024 * 1024 - 2));
  expect(() =>
    preparePrivateSegment({
      segmentId: "private",
      executionId: "execution",
      taskId: "task",
      previous: null,
      firstSequence: "0",
      lastSequence: "16",
      entries,
      contentHash: "not-yet-published",
      encodedBytes: 0,
      createdAt: 1,
    }),
  ).toThrow(expect.objectContaining({ code: "segment_entry_too_large" }));
});
