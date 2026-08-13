import { describe, expect, it } from "vitest";
import { encodedJsonBytes, segmentValues, spillEligibleRoots } from "../segmentation.ts";

const entries = Array.from({ length: 25 }, (_, index) => ({ index, text: "x" }));

describe("bounded segmentation", () => {
  it("seals before count or byte targets and never splits an entry", () => {
    const segments = segmentValues(entries, { maxEntries: 10, maxEncodedBytes: 8_192 });
    expect(segments.map((segment) => segment.entries.length)).toEqual([10, 10, 5]);
    expect(segments.flatMap((segment) => segment.entries)).toEqual(entries);
    expect(segments.every((segment) => segment.encodedBytes >= 0)).toBe(true);
  });

  it("seals on encoded bytes before adding the overflowing entry", () => {
    const first = { value: "a" };
    const second = { value: "b" };
    const target = encodedJsonBytes(first) + encodedJsonBytes(second) - 1;
    const segments = segmentValues([first, second], { maxEntries: 10, maxEncodedBytes: target });
    expect(segments.map((segment) => segment.entries)).toEqual([[first], [second]]);
  });

  it("does not spill mutable roots and spills sealed roots oldest first", () => {
    const roots = Array.from({ length: 5 }, (_, index) => ({ index }));
    expect(spillEligibleRoots(roots, 0, { maxRoots: 4, maxEncodedBytes: 1_024 })).toEqual([]);
    expect(spillEligibleRoots(roots, 5, { maxRoots: 4, maxEncodedBytes: 1_024 })).toEqual(
      roots.slice(0, 4),
    );
  });
});
