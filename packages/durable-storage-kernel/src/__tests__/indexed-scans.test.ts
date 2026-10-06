import { run } from "effection";
import { describe, expect, it } from "vitest";
import { durableKey } from "../codec.ts";
import { DurableCollections, DurableIndexes } from "../collections.ts";
import type { BoundedScan } from "../contract.ts";
import { createMemoryDurableKernel } from "../memory.ts";
import { seek } from "../ordered-seek.ts";

const collection = DurableCollections.executionJournalSegments;
const request: BoundedScan = {
  collection,
  index: DurableIndexes.taskSequence,
  scope: durableKey("execution", "task"),
  direction: "forward",
  after: null,
  maxRecords: 2,
  maxStoredBytes: 100,
};
const segment = (position: string, execution = "execution") => ({
  name: `segment-${execution}-${position}`,
  collection,
  key: durableKey(`id-${execution}-${position}`),
  alternateKeys: [durableKey(execution, "task", position, "segment")],
  fingerprint: position,
  value: new Uint8Array([1, 2, 3]),
});

describe("indexed memory scans", () => {
  it("seeks deep cursors in logarithmic work", () => {
    let visited = 0;
    const index = seek(1_000_000, (offset) => {
      visited++;
      return offset <= 900_000;
    });
    expect(index).toBe(900_001);
    expect(visited).toBeLessThanOrEqual(20);
  });

  it("pages numerically in both directions, isolating scopes and respecting frontiers", async () => {
    const kernel = createMemoryDurableKernel();
    await run(function* () {
      for (const position of ["9007199254740993", "10", "2", "9007199254740992"])
        yield* kernel.apply({ ensures: [segment(position), segment(position, "unrelated")] });
      const first = yield* kernel.scan(request);
      expect(first.records.map((record) => record.position)).toEqual(["2", "10"]);
      expect(first.nextCursor).toBe("10");
      const second = yield* kernel.scan({ ...request, after: first.nextCursor });
      expect(second.records.map((record) => record.position)).toEqual([
        "9007199254740992",
        "9007199254740993",
      ]);
      expect(second.nextCursor).toBeNull();
      const reverse = yield* kernel.scan({
        ...request,
        direction: "backward",
        after: "9007199254740993",
        through: "10",
      });
      expect(reverse.records.map((record) => record.position)).toEqual(["9007199254740992", "10"]);
      expect(reverse.nextCursor).toBeNull();
      const bounded = yield* kernel.scan({ ...request, through: "2" });
      expect(bounded.records.map((record) => record.position)).toEqual(["2"]);
      expect(bounded.nextCursor).toBeNull();
      expect(
        (yield* kernel.scan({ ...request, scope: durableKey("missing", "task") })).records,
      ).toEqual([]);
    });
  });

  it("enforces byte bounds without duplicating aliases or exposing mutable payloads", async () => {
    const kernel = createMemoryDurableKernel();
    await run(function* () {
      const first = segment("1");
      yield* kernel.apply({
        ensures: [
          {
            ...first,
            alternateKeys: [...first.alternateKeys, durableKey("execution", "task", "1", "other")],
          },
          segment("2"),
        ],
      });
      yield* kernel.apply({ ensures: [first] });
      const page = yield* kernel.scan({ ...request, maxStoredBytes: 3 });
      expect(page.records.map((record) => record.position)).toEqual(["1"]);
      expect(page.nextCursor).toBe("1");
      page.records[0]!.value[0] = 99;
      expect((yield* kernel.readImmutable(collection, first.key))!.value).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      const next = yield* kernel.scan({ ...request, after: page.nextCursor });
      expect(next.records.map((record) => record.position)).toEqual(["2"]);
      expect(next.nextCursor).toBeNull();
    });
  });

  it("indexes claims and does not publish failed ensures into the index", async () => {
    const kernel = createMemoryDurableKernel();
    await run(function* () {
      const claim = { ...segment("1"), key: durableKey("execution", "task", "1", "claimed") };
      yield* kernel.apply({ claim, ensures: [] });
      const result = yield* kernel.apply({
        ensures: [segment("2")],
        authority: {
          name: "control",
          collection: DurableCollections.executionControls,
          key: durableKey("execution"),
          expected: { revision: "99" },
          next: { revision: "100", value: new Uint8Array() },
        },
      });
      expect(result.status).toBe("authority_conflict");
      expect((yield* kernel.scan(request)).records.map((record) => record.position)).toEqual(["1"]);
    });
  });
});
