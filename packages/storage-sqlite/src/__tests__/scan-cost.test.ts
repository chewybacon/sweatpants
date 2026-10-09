import Database from "better-sqlite3";
import { openBetterSqliteStorageForTest } from "../testing.ts";
import { describe, expect, it } from "vitest";
import { run } from "effection";
import { canonicalDigest, canonicalJson, sha256 } from "@sweatpants/foundation";
import { durableKey, type BoundedScan } from "@sweatpants/durable-storage-kernel";
import { preparePrivateSegment } from "@sweatpants/journal-authority/store-persistence";

const request: BoundedScan = {
  collection: "execution-journal-segments",
  index: "task-sequence",
  scope: durableKey("scan-budget", "task"),
  direction: "forward",
  after: "0",
  maxRecords: 3,
  maxPayloadBytes: 1024 * 1024,
};
function segment(position: string, body: string, executionId = "scan-budget") {
  const entries = [body];
  const encoded = canonicalJson(entries);
  const encodedDigest = sha256(encoded);
  const value = preparePrivateSegment({
    segmentId: `${executionId}-${position}`,
    executionId,
    taskId: "task",
    previous: null,
    firstSequence: position,
    lastSequence: position,
    entries,
    contentHash: encodedDigest,
    encodedBytes: new TextEncoder().encode(encoded).byteLength,
    createdAt: 1,
  });
  return {
    name: "segment",
    collection: "execution-journal-segments" as const,
    key: durableKey(`${executionId}-${position}`),
    fingerprint: encodedDigest,
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
        handle.kernel.scan({ ...request, maxPayloadBytes: first.value.encodedBytes }),
      );
      expect(page.records.map((record) => record.position)).toEqual(["1"]);
      expect(page.records[0]!.value).toEqual(first.value);
      expect(page.records[0]!.payloadBytes).toBe(first.value.encodedBytes);
      expect(page.nextCursor).toBe("1");
      expect(queries).toHaveLength(2);
      expect(queries[0]!).toContain('"encoded_bytes"');
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
      await expect(
        run(() =>
          handle.kernel.scan({ ...request, maxPayloadBytes: first.value.encodedBytes - 1 }),
        ),
      ).rejects.toMatchObject({ code: "durable_kernel_scan_limit_exceeded" });
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

it("bounds terminal JSON payloads by database byte length and root-index metadata by rows", async () => {
  const handle = await run(() => openBetterSqliteStorageForTest(":memory:", { initialize: true }));
  try {
    const entries = ["選択 🃏", { answer: true }];
    const value = {
      segmentId: "terminal-byte-budget",
      conversationId: "terminal-byte-budget",
      logicalTurnId: "turn",
      executionId: "execution",
      publicationKey: "publication",
      previous: null,
      firstPosition: "1",
      lastPosition: "1",
      entries,
      contentHash: canonicalDigest(entries),
      createdAt: 1,
    };
    await run(() =>
      handle.kernel.apply({
        ensures: [
          {
            name: "terminal",
            collection: "conversation-terminal-segments",
            key: durableKey(value.segmentId),
            fingerprint: value.contentHash,
            value,
          },
        ],
      }),
    );
    const scan: BoundedScan = {
      collection: "conversation-terminal-segments",
      index: "conversation-position",
      scope: durableKey(value.conversationId),
      direction: "forward",
      after: null,
      maxRecords: 1,
      maxPayloadBytes: new TextEncoder().encode(JSON.stringify(entries)).byteLength,
    };
    const page = await run(() => handle.kernel.scan(scan));
    expect(page.records).toHaveLength(1);
    expect(page.records[0]!.payloadBytes).toBe(scan.maxPayloadBytes);
    await expect(
      run(() => handle.kernel.scan({ ...scan, maxPayloadBytes: scan.maxPayloadBytes - 1 })),
    ).rejects.toMatchObject({ code: "durable_kernel_scan_limit_exceeded" });
    for (const position of ["1", "2"]) {
      const root = {
        conversationId: value.conversationId,
        position,
        rootId: `root-${position}`,
        segmentId: "referenced-segment",
        segmentRootIndex: Number(position),
        archiveOrdinal: position,
        contentHash: canonicalDigest(position),
        encodedBytes: 1_000_000,
      };
      await run(() =>
        handle.kernel.apply({
          ensures: [
            {
              name: "root",
              collection: "conversation-public-root-index",
              key: durableKey(root.conversationId, position),
              fingerprint: canonicalDigest(root),
              value: root,
            },
          ],
        }),
      );
    }
    const indexPage = await run(() =>
      handle.kernel.scan({
        ...scan,
        collection: "conversation-public-root-index",
        maxPayloadBytes: 1,
      }),
    );
    expect(indexPage.records.map((record) => record.position)).toEqual(["1"]);
    expect(indexPage.records[0]!.payloadBytes).toBe(0);
    expect(indexPage.nextCursor).toBe("1");
  } finally {
    await run(() => handle.close());
  }
});
