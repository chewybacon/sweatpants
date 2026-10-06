import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "effection";
import { describeConversationStoreConformance } from "@sweatpants/history-store/conformance";
import { describeExecutionStoreConformance } from "@sweatpants/journal-authority/store-conformance";
import { durableKey } from "@sweatpants/durable-storage-kernel";
import { createD1DurableKernel, createD1Storage, initializeD1Storage } from "../index.ts";
import type { D1Database } from "@cloudflare/workers-types";
let mf: Miniflare;
let db: D1Database;
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: "journal",
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
          env: { JOURNAL: { type: "d1", id: "journal" } },
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
async function fresh() {
  await db.batch(
    ["sp_d1_positions", "sp_d1_aliases", "sp_d1_chunks", "sp_d1_records"].map((table) =>
      db.prepare(`DELETE FROM ${table}`),
    ),
  );
  return createD1Storage(db);
}
describeConversationStoreConformance([
  {
    name: "d1",
    async create() {
      return { store: (await fresh()).conversationStore, close: async () => {} };
    },
  },
]);
describeExecutionStoreConformance([
  {
    name: "d1",
    async create() {
      return { store: (await fresh()).executionStore, close: async () => {} };
    },
  },
]);
describe("D1 atomic kernel", () => {
  it("admits exactly one concurrent claimant and rolls back losing ensures", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(() =>
          kernel.apply({
            claim: {
              name: "claim",
              collection: "conversation-command-receipts",
              key: durableKey("claim"),
              fingerprint: "same",
              value: new Uint8Array([i]),
            },
            ensures: [
              {
                name: "object",
                collection: "execution-objects",
                key: durableKey(String(i)),
                fingerprint: String(i),
                value: new Uint8Array([i]),
              },
            ],
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "claim_exists")).toHaveLength(7);
    const rows = await db
      .prepare("SELECT key FROM sp_d1_records WHERE collection='execution-objects'")
      .all();
    expect(rows.results).toHaveLength(1);
  });
  it("rolls back the entire batch when a later database write fails", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    await db
      .prepare(
        "CREATE TRIGGER fail_chunk BEFORE INSERT ON sp_d1_chunks BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
      )
      .run();
    const token = await db.prepare("SELECT token FROM sp_d1_meta").first("token");
    try {
      await expect(
        run(() =>
          kernel.apply({
            claim: {
              name: "receipt",
              collection: "conversation-command-receipts",
              key: durableKey("rollback"),
              fingerprint: "one",
              value: new Uint8Array([1]),
            },
            ensures: [],
            authority: {
              name: "head",
              collection: "conversation-heads",
              key: durableKey("rollback"),
              expected: { revision: null },
              next: { revision: "0", value: new Uint8Array([2]) },
            },
          }),
        ),
      ).rejects.toThrow("injected failure");
      expect(await db.prepare("SELECT COUNT(*) AS count FROM sp_d1_records").first("count")).toBe(
        0,
      );
      expect(await db.prepare("SELECT token FROM sp_d1_meta").first("token")).toBe(token);
    } finally {
      await db.prepare("DROP TRIGGER fail_chunk").run();
    }
  });
  it("fences concurrent authority writers without leaking the losing objects", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(() =>
          kernel.apply({
            ensures: [
              {
                name: "object",
                collection: "execution-objects",
                key: durableKey(String(i)),
                fingerprint: String(i),
                value: new Uint8Array([i]),
              },
            ],
            authority: {
              name: "control",
              collection: "execution-controls",
              key: durableKey("race"),
              expected: { revision: null },
              next: { revision: "0", fence: "9007199254740993", value: new Uint8Array([i]) },
            },
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "authority_conflict")).toHaveLength(7);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS count FROM sp_d1_records WHERE collection='execution-objects'")
        .first("count"),
    ).toBe(1);
    expect(
      (await run(() => kernel.readAuthority("execution-controls", durableKey("race"))))?.fence,
    ).toBe("9007199254740993");
  });
  it("orders counters above Number precision and respects scan byte bounds", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const positions = ["9007199254740993", "9007199254740994", "10000000000000000"];
    for (const position of positions)
      await run(() =>
        kernel.apply({
          ensures: [
            {
              name: "segment",
              collection: "conversation-public-segments",
              key: durableKey(position),
              alternateKeys: [durableKey("scan", position, position)],
              fingerprint: position,
              value: new Uint8Array([1, 2]),
            },
          ],
        }),
      );
    const query = {
      collection: "conversation-public-segments" as const,
      index: "conversation-position" as const,
      scope: durableKey("scan"),
      direction: "forward" as const,
      after: null,
      maxRecords: 10,
      maxStoredBytes: 4,
    };
    const page = await run(() => kernel.scan(query));
    expect(page.records.map((r) => r.position)).toEqual(positions.slice(0, 2));
    expect(page.nextCursor).toBe(positions[1]);
    expect(
      (await run(() => kernel.scan({ ...query, after: page.nextCursor }))).records.map(
        (r) => r.position,
      ),
    ).toEqual(positions.slice(2));
  });
  it("resolves alternate identity races to the original immutable record", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const results = await Promise.all(
      ["first", "second"].map((key) =>
        run(() =>
          kernel.apply({
            ensures: [
              {
                name: "object",
                collection: "execution-objects",
                key: durableKey(key),
                alternateKeys: [durableKey("alias")],
                fingerprint: "same",
                value: new Uint8Array([1]),
              },
            ],
          }),
        ),
      ),
    );
    expect(results.every((r) => r.status === "committed")).toBe(true);
    expect(results[0]).toEqual(results[1]);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM sp_d1_records").first("count")).toBe(1);
  });
  it("roundtrips a record larger than D1's row limit", async () => {
    await fresh();
    const kernel = createD1DurableKernel(db);
    const value = new Uint8Array(2_100_000).fill(42);
    await run(() =>
      kernel.apply({
        ensures: [
          {
            name: "large",
            collection: "execution-objects",
            key: durableKey("large"),
            fingerprint: "large",
            value,
          },
        ],
      }),
    );
    const result = await run(() => kernel.readImmutable("execution-objects", durableKey("large")));
    expect(result?.value.byteLength).toBe(value.byteLength);
    expect(result?.value.every((byte) => byte === 42)).toBe(true);
  });
});
