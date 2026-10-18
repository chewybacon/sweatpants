import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { run } from "effection";
import { expect, it } from "vitest";
import { canonicalDigest } from "@sweatpants/foundation";
import {
  durableKey,
  type DurableKernel,
  type ImmutableEnsure,
  type OrderedCollectionId,
} from "@sweatpants/durable-storage-kernel";
import {
  BetterSqliteDatabase,
  openBetterSqliteStorageForTest,
} from "@sweatpants/storage-sqlite/better-sqlite3";
import { createD1DurableKernel, initializeD1Storage } from "../index.ts";
import {
  headValue,
  controlValue,
  checkpointEnsure,
  publicEnsure,
  objectEnsure,
  receiptClaim,
} from "./fixtures/domain-records.ts";
import { meterD1 } from "./fixtures/d1-meter.ts";

// The same public operations produce real SQL on both engines. Assertions remain
// here rather than testing hand-written lookalike queries.
async function exercise(kernel: DurableKernel) {
  const entries = ["entry"];
  const contentHash = canonicalDigest(entries);
  const terminal = {
    segmentId: "terminal",
    conversationId: "target",
    logicalTurnId: "turn",
    executionId: "target",
    publicationKey: "publication",
    previous: null,
    firstPosition: "1",
    lastPosition: "1",
    entries,
    contentHash,
    createdAt: 1,
  };
  const root = {
    conversationId: "target",
    position: "1",
    rootId: "root",
    segmentId: "target-1",
    segmentRootIndex: 0,
    archiveOrdinal: "1",
    contentHash,
    encodedBytes: 9,
  };
  const ensures: ImmutableEnsure[] = [
    checkpointEnsure("checkpoint", "target", "cause", null),
    publicEnsure("target", "1"),
    objectEnsure("object", null),
    {
      name: "root",
      collection: "conversation-public-root-index",
      key: durableKey("target", "1"),
      alternateKeys: [durableKey("target", "root", "root")],
      fingerprint: canonicalDigest(root),
      value: root,
    },
    {
      name: "terminal",
      collection: "conversation-terminal-segments",
      key: durableKey("terminal"),
      alternateKeys: [durableKey("target", "publication"), durableKey("target", "1", "terminal")],
      fingerprint: contentHash,
      value: terminal,
    },
  ];
  for (const collection of ["execution-journal-segments", "execution-replay-segments"] as const) {
    for (let i = 0; i < 4; i++) {
      const id = `${collection}-${i}`;
      ensures.push({
        name: id,
        collection,
        key: durableKey(id),
        alternateKeys: [durableKey("target", "task", String(i), String(i))],
        fingerprint: contentHash,
        value: {
          segmentId: id,
          executionId: "target",
          taskId: "task",
          previous: null,
          firstSequence: String(i),
          lastSequence: String(i),
          entries,
          contentHash,
          encodedBytes: 9,
          createdAt: 1,
        },
      });
    }
  }
  const claim = receiptClaim("target", "command");
  expect((await run(() => kernel.apply({ ensures, claim }))).status).toBe("committed");
  expect((await run(() => kernel.apply({ ensures }))).status).toBe("committed");
  for (const collection of ["execution-journal-segments", "execution-replay-segments"]) {
    expect(
      (
        await run(() =>
          kernel.apply({
            ensures: ensures.filter((ensure) => ensure.collection === collection).slice(0, 1),
          }),
        )
      ).status,
    ).toBe("committed");
  }
  expect((await run(() => kernel.apply({ ensures: [], claim }))).status).toBe("claim_exists");
  for (const ensure of [...ensures, claim]) {
    for (const key of [
      ensure.key,

      ...("alternateKeys" in ensure ? (ensure.alternateKeys ?? []) : []),
    ]) {
      expect(await run(() => kernel.readImmutable(ensure.collection, key))).not.toBeNull();
    }
    // Misses exercise exactly the same identities and index shapes.
    expect(
      await run(() =>
        kernel.readImmutable(
          ensure.collection,
          ensure.collection === "conversation-command-receipts" ||
            ensure.collection === "conversation-public-root-index"
            ? durableKey("missing", "0")
            : durableKey("missing"),
        ),
      ),
    ).toBeNull();
  }
  for (const collection of ["conversation-heads", "execution-controls"] as const) {
    for (const revision of ["0", "1"]) {
      const value =
        collection === "conversation-heads"
          ? {
              ...headValue("target", revision).value,
              terminalHistory: { segmentId: "terminal", lastPosition: "1" },
            }
          : controlValue("target", revision).value;
      const authority = {
        name: "authority",
        collection,
        key: durableKey("target"),
        expected: { revision: revision === "0" ? null : "0" },
        next: { revision, value },
      };
      expect((await run(() => kernel.apply({ ensures: [], authority }))).status).toBe("committed");
      expect(
        await run(() => kernel.readAuthority(collection, durableKey("target"))),
      ).not.toBeNull();
      expect((await run(() => kernel.apply({ ensures: [], authority }))).status).toBe(
        "authority_conflict",
      );
    }
    expect(await run(() => kernel.readAuthority(collection, durableKey("missing")))).toBeNull();
  }
  for (const collection of [
    "conversation-public-segments",
    "conversation-public-root-index",
    "conversation-terminal-segments",
    "execution-journal-segments",
    "execution-replay-segments",
  ] as const) {
    for (const direction of ["forward", "backward"] as const) {
      for (const bounded of [false, true]) {
        const privateScope = collection.startsWith("execution");
        const page = await run(() =>
          kernel.scan({
            collection: collection as OrderedCollectionId,
            index: privateScope ? "task-sequence" : "conversation-position",
            scope: privateScope ? durableKey("target", "task") : durableKey("target"),
            direction,
            after: bounded ? (direction === "forward" ? "0" : "4") : null,
            through: direction === "forward" ? "4" : "0",
            maxRecords: 2,
            maxPayloadBytes: 10000,
          }),
        );
        expect(page.records.length).toBeGreaterThan(0);
        expect(page.records.length).toBeLessThanOrEqual(2);
      }
    }
  }
}

it("traces every domain identity, scan direction, and mutation read on SQLite", async () => {
  const queries: string[] = [];
  const db = new BetterSqliteDatabase(":memory:", {
    verbose: (query) => queries.push(String(query)),
  });
  const handle = await run(() =>
    openBetterSqliteStorageForTest(undefined, { database: db, initialize: true }),
  );
  try {
    queries.length = 0;
    await exercise(handle.kernel);
    const statements = [
      ...new Set(queries.filter((query) => /^(select|update|delete)/i.test(query))),
    ];
    const trace = [];
    for (const query of statements) {
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as { detail: string }[];
      const details = rows.map((row) => row.detail).join("\n");
      trace.push({ sql: query, plan: rows.map((row) => row.detail) });
      expect(details, query).toContain("SEARCH");
      expect(details, query).not.toMatch(/\bSCAN\b|USE TEMP B-TREE/);
    }
    await saveTrace("sqlite", trace);
    console.info(JSON.stringify({ engine: "sqlite", tracedStatements: statements.length }));
  } finally {
    await run(() => handle.close());
    db.close();
  }
});

it("traces every D1 identity, scan and atomic guard against real workerd billing metadata", async () => {
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "query-paths",
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
          env: { JOURNAL: { type: "d1", id: "query-paths" } },
        },
      },
    ],
  });
  try {
    const db = (await mf.getD1Database("JOURNAL")) as unknown as D1Database;
    await initializeD1Storage(db);
    const meter = meterD1(db);
    const kernel = createD1DurableKernel(meter.database);
    await exercise(kernel);
    // Mutable overflow replacement exercises chunk deletes and snapshot joins.
    for (const [revision, body] of ["x".repeat(1_100_000), "inline"].entries()) {
      expect(
        (
          await run(() =>
            kernel.apply({
              ensures: [],
              authority: {
                name: "overflow",
                collection: "execution-controls",
                key: durableKey("overflow"),
                expected: { revision: revision === 0 ? null : "0" },
                next: {
                  revision: String(revision),
                  ...controlValue("overflow", String(revision), "0", body),
                },
              },
            }),
          )
        ).status,
      ).toBe("committed");
      expect(
        await run(() => kernel.readAuthority("execution-controls", durableKey("overflow"))),
      ).not.toBeNull();
    }
    let maxRowsRead = 0;
    const trace = [];
    for (const query of meter.queries) {
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.bindings)
        .all<{ detail: string }>();
      const details = plan.results.map((row) => row.detail).join("\n");
      trace.push({
        sql: query.sql,
        bindings: query.bindings.length,
        rowsRead: query.rowsRead,
        rowsWritten: query.rowsWritten,
        plan: plan.results.map((row) => row.detail),
      });
      // The CAS guard enumerates the bounded mutation's JSON input. Those
      // constant/virtual scans are not scans over persisted application data.
      expect(details, query.sql).not.toMatch(/SCAN (?:sp_\w+|actual\b|c\b)|USE TEMP B-TREE/);
      expect(query.rowsRead, query.sql).toBeLessThanOrEqual(150);
      maxRowsRead = Math.max(maxRowsRead, query.rowsRead);
    }
    await saveTrace("d1", trace);
    console.info(
      JSON.stringify({ engine: "d1", tracedStatements: meter.queries.length, maxRowsRead }),
    );
  } finally {
    await mf.dispose();
  }
});

async function saveTrace(engine: string, trace: unknown[]) {
  const directory = process.env.STORAGE_QUERY_TRACE_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${engine}.json`), JSON.stringify(trace, null, 2));
  }
}
