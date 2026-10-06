import Database from "better-sqlite3";
import { openBetterSqliteStorageForTest } from "../testing.ts";
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { canonicalSnapshot } from "@sweatpants/foundation";
import { durableKey, type BoundedScan } from "@sweatpants/durable-storage-kernel";
import { encodePrivateSegment } from "@sweatpants/journal-authority/store-persistence";

const request: BoundedScan = {
  collection: "execution-journal-segments",
  index: "task-sequence",
  scope: durableKey("scan-budget", "task"),
  direction: "forward",
  after: "0",
  maxRecords: 3,
  maxStoredBytes: 1024 * 1024,
};
function segment(position: string, body: string, executionId = "scan-budget") {
  const entries = [body];
  const encoded = canonicalSnapshot(entries);
  const value = encodePrivateSegment({
    segmentId: `${executionId}-${position}`,
    executionId,
    taskId: "task",
    previous: null,
    firstSequence: position,
    lastSequence: position,
    entries,
    contentHash: encoded.sha,
    encodedBytes: new TextEncoder().encode(encoded.canonical).byteLength,
    createdAt: 1,
  });
  return {
    name: "segment",
    collection: "execution-journal-segments" as const,
    key: durableKey(`${executionId}-${position}`),
    fingerprint: encoded.sha,
    value,
  };
}
describe("SQLite bounded scans", () => {
  it("seeks metadata first, loads only the budgeted payloads, and preserves cursors and scope", async () => {
    const queries: string[] = [];
    const database = new Database(":memory:", { verbose: (query) => queries.push(String(query)) });
    const handle = await run(() =>
      openBetterSqliteStorageForTest(undefined, { database, initialize: true }),
    );
    try {
      const first = segment("1", "選択 🃏");
      const second = segment("2", "large".repeat(1000));
      const third = segment("3", "last");
      for (const entry of [
        segment("0", "before"),
        first,
        second,
        third,
        segment("1", "other", "unrelated"),
      ]) {
        await run(() => handle.kernel.apply({ ensures: [entry] }));
      }
      queries.length = 0;
      const page = await run(() =>
        handle.kernel.scan({ ...request, maxStoredBytes: first.value.byteLength }),
      );
      expect(page.records.map((record) => record.position)).toEqual(["1"]);
      expect(page.records[0]!.value).toEqual(first.value);
      expect(page.records[0]!.storedBytes).toBe(first.value.byteLength);
      expect(page.nextCursor).toBe("1");
      expect(queries).toHaveLength(2);
      expect(queries[0]!).toContain('"stored_bytes"');
      expect(queries[0]!).not.toContain('"entries_json"');
      expect(queries[0]!.toLowerCase()).toContain("limit");
      expect(queries[1]!).toContain('"entries_json"');
      const plan = database.prepare(`EXPLAIN QUERY PLAN ${queries[0]!}`).all() as {
        detail: string;
      }[];
      expect(
        plan.some(
          (row) => row.detail.includes("SEARCH") && row.detail.includes("sp_journal_task_sequence"),
        ),
      ).toBe(true);
      queries.length = 0;
      const tooSmall = await run(() =>
        handle.kernel.scan({ ...request, maxStoredBytes: first.value.byteLength - 1 }),
      );
      expect(tooSmall.records).toEqual([]);
      expect(queries).toHaveLength(1);
      expect(queries[0]!).not.toContain('"entries_json"');
      const next = await run(() =>
        handle.kernel.scan({ ...request, after: page.nextCursor, through: "2" }),
      );
      expect(next.records.map((record) => record.position)).toEqual(["2"]);
      expect(next.nextCursor).toBeNull();
      const backwards = await run(() =>
        handle.kernel.scan({
          ...request,
          direction: "backward",
          after: "4",
          through: "2",
          maxRecords: 1,
        }),
      );
      expect(backwards.records.map((record) => record.position)).toEqual(["3"]);
      expect(backwards.nextCursor).toBe("3");
    } finally {
      await run(() => handle.close());
      database.close();
    }
  });
});

it("accepts a bulk journal ensure without optional alternate keys", async () => {
  const handle = await run(() => openBetterSqliteStorageForTest(":memory:", { initialize: true }));
  try {
    const entries = Array.from({ length: 4 }, (_, index) => ({
      ...segment(String(index + 1), "bulk", `bulk-${Date.now()}`),
      name: `segment-${index}`,
    }));
    const result = await run(() => handle.kernel.apply({ ensures: entries }));
    expect(result.status).toBe("committed");
    for (const entry of entries) {
      expect(
        (await run(() => handle.kernel.readImmutable(entry.collection, entry.key)))?.value,
      ).toEqual(entry.value);
    }
  } finally {
    await run(() => handle.close());
  }
});
