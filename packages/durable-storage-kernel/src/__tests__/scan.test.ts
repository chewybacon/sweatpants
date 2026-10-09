import { describe, expect, it } from "vitest";
import type { BoundedScan } from "../contract.ts";
import { planScanPage } from "../scan.ts";

const request: BoundedScan = {
  collection: "execution-journal-segments",
  index: "task-sequence",
  scope: "[]",
  direction: "forward",
  after: null,
  maxRecords: 3,
  maxPayloadBytes: 10,
};
const rows = [
  { key: "a", position: "9007199254740992", payloadBytes: 4 },
  { key: "b", position: "9007199254740993", payloadBytes: 6 },
  { key: "c", position: "9007199254740994", payloadBytes: 1 },
];

describe("metadata page selection", () => {
  it("uses exact byte bounds and returns the last selected counter without numeric coercion", () => {
    expect(planScanPage(request, rows)).toEqual({
      selected: rows.slice(0, 2),
      nextCursor: rows[1]!.position,
    });
    expect(planScanPage({ ...request, maxPayloadBytes: 11 }, rows)).toEqual({
      selected: rows,
      nextCursor: null,
    });
  });
  it("stops at the first oversized row instead of skipping ahead", () => {
    expect(planScanPage({ ...request, maxPayloadBytes: 5 }, rows)).toEqual({
      selected: [rows[0]],
      nextCursor: rows[0]!.position,
    });
    expect(() => planScanPage({ ...request, maxPayloadBytes: 3 }, rows)).toThrow(
      expect.objectContaining({ code: "durable_kernel_scan_limit_exceeded" }),
    );
  });
  it("counts metadata-only rows and keeps payload continuation contiguous", () => {
    const metadata = { ...rows[0]!, payloadBytes: 0 };
    expect(planScanPage({ ...request, maxRecords: 1 }, [metadata, rows[1]!])).toEqual({
      selected: [metadata],
      nextCursor: metadata.position,
    });
    expect(
      planScanPage({ ...request, maxPayloadBytes: 6 }, [metadata, rows[1]!, rows[2]!]),
    ).toEqual({
      selected: [metadata, rows[1]],
      nextCursor: rows[1]!.position,
    });
    expect(
      planScanPage({ ...request, after: rows[1]!.position, maxPayloadBytes: 6 }, [rows[2]!]),
    ).toEqual({
      selected: [rows[2]],
      nextCursor: null,
    });
  });
  it("uses lookahead for count limits and preserves reverse order", () => {
    const reverse = rows.toReversed();
    expect(planScanPage({ ...request, direction: "backward", maxRecords: 1 }, reverse)).toEqual({
      selected: [reverse[0]],
      nextCursor: reverse[0]!.position,
    });
    expect(planScanPage(request, [])).toEqual({ selected: [], nextCursor: null });
  });
  it.each([-1, NaN, Infinity, 0.5])("rejects corrupt size metadata %s", (payloadBytes) => {
    expect(() => planScanPage(request, [{ ...rows[0]!, payloadBytes }])).toThrow(
      "Invalid indexed record byte count",
    );
  });
});
