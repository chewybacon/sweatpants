import { describe, expect, it } from "vitest";
import { assertCheckpointBounds, CHECKPOINT_BOUNDS } from "../checkpoint-bounds.ts";

function atMaximums() {
  return {
    encodedBytes: CHECKPOINT_BOUNDS.maxTotalBytes,
    totalRoots: CHECKPOINT_BOUNDS.maxTotalRoots,
    mutableRoots: CHECKPOINT_BOUNDS.maxMutableRoots,
    openInterrupts: CHECKPOINT_BOUNDS.maxOpenInterrupts,
    largestInlineRootBytes: CHECKPOINT_BOUNDS.maxInlineRootBytes,
  };
}

describe("checkpoint hard bounds", () => {
  it("accepts every exact maximum", () => {
    expect(() => assertCheckpointBounds(atMaximums())).not.toThrow();
  });

  it.each([
    ["encodedBytes", "maxTotalBytes"],
    ["totalRoots", "maxTotalRoots"],
    ["mutableRoots", "maxMutableRoots"],
    ["openInterrupts", "maxOpenInterrupts"],
    ["largestInlineRootBytes", "maxInlineRootBytes"],
  ] as const)("rejects %s at maximum plus one", (field, maximum) => {
    const value = atMaximums();
    (value as Record<string, number>)[field] = CHECKPOINT_BOUNDS[maximum] + 1;
    expect(() => assertCheckpointBounds(value)).toThrowError(
      expect.objectContaining({ code: "checkpoint_bound_exceeded", field }),
    );
  });
});
