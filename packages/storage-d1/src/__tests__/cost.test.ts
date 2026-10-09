import type { D1Database } from "@cloudflare/workers-types";
import { run } from "effection";
import { Miniflare } from "miniflare";
import { beforeAll, afterAll, expect, it } from "vitest";
import { canonicalJson, sha256 } from "@sweatpants/foundation";
import { durableKey } from "@sweatpants/durable-storage-kernel";
import { createD1DurableKernel, initializeD1Storage } from "../index.ts";
import { headValue, checkpointEnsure, publicEnsure } from "./fixtures/domain-records.ts";
import { meterD1 } from "./fixtures/d1-meter.ts";
let mf: Miniflare;
let db: D1Database;
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "cost",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": {
                type: "esm",
                contents: "export default {fetch(){return new Response('ok')}}",
              },
            },
          },
          env: { JOURNAL: { type: "d1", id: "cost" } },
        },
      },
    ],
  });
  db = (await mf.getD1Database("JOURNAL")) as unknown as D1Database;
  await initializeD1Storage(db);
});
afterAll(async () => {
  await mf?.dispose();
});

it("keeps point reads, deep range seeks and writes bounded as unrelated records grow", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  const seed = createD1DurableKernel(db);
  for (let position = 0; position < 30; position++) {
    await run(() => seed.apply({ ensures: [publicEnsure("target", String(position), position)] }));
  }
  for (const count of [100, 10000]) {
    // Index entries preceding the requested cursor and other scopes must not be scanned.
    await db
      .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
      INSERT OR IGNORE INTO sp_conversation_public_segments
      (segment_id,conversation_id,previous_segment_id,min_position,max_position,roots_json,content_hash,encoded_bytes,created_at)
      SELECT 'noise-'||x,'target',NULL,0,0,'[]','noise',2,0 FROM n`)
      .bind(count)
      .run();
    meter.queries.length = 0;
    const point = await run(() =>
      kernel.readImmutable("conversation-public-segments", durableKey("target-29")),
    );
    expect(point?.value).toEqual(publicEnsure("target", "29", 29).value);
    const forward = await run(() =>
      kernel.scan({
        collection: "conversation-public-segments",
        index: "conversation-position",
        scope: durableKey("target"),
        after: "24",
        direction: "forward",
        maxRecords: 3,
        maxPayloadBytes: 10000,
      }),
    );
    expect(forward.records.map((record) => record.position)).toEqual(["25", "26", "27"]);
    const backward = await run(() =>
      kernel.scan({
        collection: "conversation-public-segments",
        index: "conversation-position",
        scope: durableKey("target"),
        after: "29",
        through: "20",
        direction: "backward",
        maxRecords: 3,
        maxPayloadBytes: 10000,
      }),
    );
    expect(backward.records.map((record) => record.position)).toEqual(["28", "27", "26"]);
    const missing = await run(() =>
      kernel.readImmutable("conversation-public-segments", durableKey("missing")),
    );
    expect(missing).toBeNull();
    const result = await run(() =>
      kernel.apply({
        ensures: [],
        authority: {
          name: "head",
          collection: "conversation-heads",
          key: durableKey(`cost-${count}`),
          expected: { revision: null },
          next: { revision: "0", ...headValue(`cost-${count}`, "0") },
        },
      }),
    );
    expect(result.status).toBe("committed");
    const rowsRead = meter.queries.reduce((sum, q) => sum + q.rowsRead, 0);
    const rowsWritten = meter.queries.reduce((sum, q) => sum + q.rowsWritten, 0);
    expect(rowsRead).toBeLessThanOrEqual(100);
    expect(rowsWritten).toBeLessThanOrEqual(10);
    for (const query of meter.queries.filter((q) => q.sql.startsWith("SELECT"))) {
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.bindings)
        .all<{ detail: string }>();
      expect(plan.results.map((row) => row.detail).join("\n")).not.toMatch(
        /\bSCAN\b|USE TEMP B-TREE/,
      );
    }
    console.info(
      JSON.stringify({
        scenario: "point+two-deep-pages+miss+commit",
        records: count,
        rowsRead,
        rowsWritten,
      }),
    );
  }
});

it("does no billable polling while waiting for a journal change", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  await run(() =>
    kernel.waitForChange({
      collection: "conversation-heads",
      key: durableKey("idle"),
      afterRevision: "0",
      timeoutMs: 120,
    }),
  );
  expect(meter.queries).toEqual([]);
});

it("bounds authority replacement and rejects stale writes before the write batch", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  const key = durableKey("rewrite");
  const mutation = (expected: string | null, next: string) => ({
    ensures: [],
    authority: {
      name: "head",
      collection: "conversation-heads" as const,
      key,
      expected: { revision: expected },
      next: { revision: next, ...headValue("rewrite", next) },
    },
  });
  await run(() => kernel.apply(mutation(null, "0")));
  meter.queries.length = 0;
  expect((await run(() => kernel.apply(mutation("0", "1")))).status).toBe("committed");
  const reads = meter.queries.reduce((sum, q) => sum + q.rowsRead, 0);
  const writes = meter.queries.reduce((sum, q) => sum + q.rowsWritten, 0);
  expect(reads).toBeLessThanOrEqual(20);
  expect(writes).toBeLessThanOrEqual(10);
  meter.queries.length = 0;
  expect((await run(() => kernel.apply(mutation("0", "2")))).status).toBe("authority_conflict");
  expect(meter.queries.reduce((sum, q) => sum + q.rowsWritten, 0)).toBe(0);
  console.info(
    JSON.stringify({ scenario: "authority-replacement", rowsRead: reads, rowsWritten: writes }),
  );
});

it("commits unrelated writers once each without charging them for retries", async () => {
  const meter = meterD1(db);
  // No retries are permitted: each writer owns a different authority identity.
  const kernel = createD1DurableKernel(meter.database, { maxAttempts: 1 });
  const results = await Promise.all(
    Array.from({ length: 32 }, (_, i) =>
      run(() =>
        kernel.apply({
          ensures: [],
          authority: {
            name: "head",
            collection: "conversation-heads",
            key: durableKey(`independent-${i}`),
            expected: { revision: null },
            next: { revision: "0", ...headValue(`independent-${i}`, "0") },
          },
        }),
      ),
    ),
  );
  expect(results.every((result) => result.status === "committed")).toBe(true);
  expect(meter.queries.filter((query) => query.sql.includes("UPDATE sp_d1_meta"))).toHaveLength(32);
  const reads = meter.queries.reduce((sum, query) => sum + query.rowsRead, 0);
  const writes = meter.queries.reduce((sum, query) => sum + query.rowsWritten, 0);
  expect(reads).toBeLessThanOrEqual(192);
  expect(writes).toBeLessThanOrEqual(192);
  console.info(
    JSON.stringify({ scenario: "32-independent-writers", rowsRead: reads, rowsWritten: writes }),
  );
});

it("protects shared immutable aliases even when authority identities differ", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  const results = await Promise.all(
    ["left", "right"].map((name) =>
      run(() =>
        kernel.apply({
          ensures: [checkpointEnsure(name, "shared-cost", "alias", { name })],
          authority: {
            name: "head",
            collection: "conversation-heads",
            key: durableKey(`alias-race-${name}`),
            expected: { revision: null },
            next: { revision: "0", ...headValue(`alias-race-${name}`, "0") },
          },
        }),
      ),
    ),
  );
  expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
  expect(results.filter((result) => result.status === "immutable_conflict")).toHaveLength(1);
  const heads = await Promise.all(
    ["left", "right"].map((name) =>
      run(() => kernel.readAuthority("conversation-heads", durableKey(`alias-race-${name}`))),
    ),
  );
  expect(heads.filter(Boolean)).toHaveLength(1);
  for (const query of meter.queries.filter((query) => query.sql.includes("UPDATE sp_d1_meta"))) {
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .bind(...query.bindings)
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail).join("\n");
    // Conflict checks must seek the domain identity indexes.
    expect(details).toContain("SEARCH");
    expect(details).not.toMatch(/SCAN (?:sp_conversation_|sp_execution_|a\b)|USE TEMP B-TREE/);
    expect(query.rowsRead).toBeLessThanOrEqual(10);
  }
});

it("performs no billable writes for an ensure-only replay", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  const mutation = { ensures: [checkpointEnsure("noop-replay", "noop", "same", { same: true })] };
  expect((await run(() => kernel.apply(mutation))).status).toBe("committed");
  meter.queries.length = 0;
  const replay = await run(() => kernel.apply(mutation));
  expect(replay.status).toBe("committed");
  expect(meter.queries.length).toBeGreaterThan(0);
  expect(meter.queries.reduce((sum, query) => sum + query.rowsWritten, 0)).toBe(0);
  expect(meter.queries.some((query) => query.sql.includes("UPDATE sp_d1_meta"))).toBe(false);
});

it("fetches a selected scan page in bounded batches, preserving direction and byte limits", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  const seed = createD1DurableKernel(db);
  for (let position = 0; position < 105; position++) {
    await run(() => seed.apply({ ensures: [publicEnsure("batched", String(position), position)] }));
  }
  for (const direction of ["forward", "backward"] as const) {
    meter.queries.length = 0;
    const page = await run(() =>
      kernel.scan({
        collection: "conversation-public-segments",
        index: "conversation-position",
        scope: durableKey("batched"),
        after: null,
        direction,
        maxRecords: 105,
        maxPayloadBytes: 100000,
      }),
    );
    const positions = Array.from({ length: 105 }, (_, i) =>
      direction === "forward" ? i : 104 - i,
    );
    expect(page.records.map((record) => Number(record.position))).toEqual(positions);
    expect(page.records.map((record) => record.value)).toEqual(
      positions.map((position) => publicEnsure("batched", String(position), position).value),
    );
    expect(page.nextCursor).toBeNull();
    // One metadata seek, then two payload queries, including the parameter-limit boundary.
    expect(meter.queries).toHaveLength(3);
    expect(meter.queries.every((query) => query.bindings.length <= 100)).toBe(true);
    for (const query of meter.queries) {
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.bindings)
        .all<{ detail: string }>();
      expect(plan.results.map((row) => row.detail).join("\n")).not.toMatch(
        /\bSCAN\b|USE TEMP B-TREE/,
      );
    }
    // D1 counts index probes as well as record/chunk rows (six per selected record).
    expect(meter.queries.reduce((sum, query) => sum + query.rowsRead, 0)).toBeLessThanOrEqual(
      6 * 105 + 1,
    );
  }
  meter.queries.length = 0;
  const bounded = await run(() =>
    kernel.scan({
      collection: "conversation-public-segments",
      index: "conversation-position",
      scope: durableKey("batched"),
      after: null,
      direction: "forward",
      maxRecords: 105,
      maxPayloadBytes:
        publicEnsure("batched", "0", 0).value.encodedBytes +
        publicEnsure("batched", "1", 1).value.encodedBytes,
    }),
  );
  expect(bounded.records.map((record) => record.position)).toEqual(["0", "1"]);
  expect(bounded.nextCursor).toBe("1");
  expect(meter.queries).toHaveLength(2);
  expect(meter.queries[1]!.bindings).toEqual(["batched-0", "batched-1"]);
});

it("assembles batched scan chunks and rejects a missing chunk", async () => {
  const kernel = createD1DurableKernel(db);
  const entries = ["x".repeat(600 * 1024), "y".repeat(600 * 1024)];
  const encoded = canonicalJson(entries);
  const value = {
    segmentId: "scan-chunks",
    executionId: "scan-chunks",
    taskId: "root",
    previous: null,
    firstSequence: "0",
    lastSequence: "1",
    entries,
    contentHash: sha256(encoded),
    encodedBytes: new TextEncoder().encode(encoded).byteLength,
    createdAt: 1,
  };
  const key = durableKey(value.segmentId);
  const ensure = {
    name: "segment",
    collection: "execution-journal-segments" as const,
    key,
    alternateKeys: [durableKey(value.executionId, value.taskId, "0", "1")],
    fingerprint: value.contentHash,
    value,
  };
  await run(() => kernel.apply({ ensures: [ensure] }));
  const request = {
    collection: "execution-journal-segments" as const,
    index: "task-sequence" as const,
    scope: durableKey("scan-chunks", "root"),
    after: null,
    direction: "forward" as const,
    maxRecords: 2,
    maxPayloadBytes: ensure.value.encodedBytes,
  };
  expect((await run(() => kernel.scan(request))).records[0]?.value).toEqual(value);
  await db
    .prepare("DELETE FROM sp_d1_payload_chunks WHERE collection=? AND key=? AND part=0")
    .bind(request.collection, key)
    .run();
  await expect(run(() => kernel.scan(request))).rejects.toThrow("Missing journal payload chunk");
});

it("bounds terminal scans by encoded entries including overflow payloads", async () => {
  const seed = createD1DurableKernel(db);
  const entriesByPosition = [["hello 🌍"], ["🌍".repeat(300_000)], ["tail"]];
  const sizes = entriesByPosition.map(
    (entries) => new TextEncoder().encode(JSON.stringify(entries)).byteLength,
  );
  for (const [position, entries] of entriesByPosition.entries()) {
    const value = {
      segmentId: `terminal-size-${position}`,
      conversationId: "terminal-size",
      logicalTurnId: "turn",
      executionId: "execution",
      publicationKey: String(position),
      previous: null,
      firstPosition: String(position),
      lastPosition: String(position),
      entries,
      contentHash: sha256(canonicalJson(entries)),
      createdAt: 1,
    };
    await run(() =>
      seed.apply({
        ensures: [
          {
            name: "segment",
            collection: "conversation-terminal-segments",
            key: durableKey(value.segmentId),
            fingerprint: value.contentHash,
            value,
          },
        ],
      }),
    );
  }
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  const page = await run(() =>
    kernel.scan({
      collection: "conversation-terminal-segments",
      index: "conversation-position",
      scope: durableKey("terminal-size"),
      after: null,
      direction: "forward",
      maxRecords: 3,
      maxPayloadBytes: sizes[0]! + sizes[1]!,
    }),
  );
  expect(page.records.map((record) => record.position)).toEqual(["0", "1"]);
  expect(page.records.map((record) => record.payloadBytes)).toEqual(sizes.slice(0, 2));
  expect(page.records[1]?.value).toMatchObject({ entries: entriesByPosition[1] });
  expect(page.nextCursor).toBe("1");
  expect(meter.queries).toHaveLength(3);
  const metadata = meter.queries[0]!;
  const plan = await db
    .prepare(`EXPLAIN QUERY PLAN ${metadata.sql}`)
    .bind(...metadata.bindings)
    .all<{ detail: string }>();
  expect(plan.results.map((row) => row.detail).join("\n")).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
});

it("seeks root-index pages numerically without sorting the whole conversation", async () => {
  const meter = meterD1(db);
  const kernel = createD1DurableKernel(meter.database);
  for (const count of [100, 10000]) {
    await db
      .prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
      INSERT OR IGNORE INTO sp_conversation_public_root_index
      (conversation_id,position,root_id,segment_id,segment_root_index,archive_ordinal,content_hash,encoded_bytes)
      SELECT 'root-cost',x,'root-'||x,'segment-'||x,0,x,'hash',1 FROM n`)
      .bind(count)
      .run();
    meter.queries.length = 0;
    for (const direction of ["forward", "backward"] as const) {
      const page = await run(() =>
        kernel.scan({
          collection: "conversation-public-root-index",
          index: "conversation-position",
          scope: durableKey("root-cost"),
          direction,
          after: direction === "forward" ? "8" : String(count - 8),
          maxRecords: 3,
          maxPayloadBytes: 1,
        }),
      );
      expect(page.records.map((record) => record.position)).toEqual(
        direction === "forward"
          ? ["9", "10", "11"]
          : [count - 9, count - 10, count - 11].map(String),
      );
    }
    for (const query of meter.queries) {
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.bindings)
        .all<{ detail: string }>();
      expect(plan.results.map((row) => row.detail).join("\n"), query.sql).not.toMatch(
        /\bSCAN\b|USE TEMP B-TREE/,
      );
      expect(query.rowsRead).toBeLessThanOrEqual(10);
    }
    console.info(
      JSON.stringify({
        scenario: "root-index-pages",
        records: count,
        rowsRead: meter.queries.map((query) => query.rowsRead),
      }),
    );
  }
});
