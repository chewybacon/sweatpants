// @vitest-environment node
import type { D1Database } from "@cloudflare/workers-types";
import { meterD1 } from "../../../../../packages/storage-d1/src/__tests__/fixtures/d1-meter";
import { createD1ThreadMetadataStore } from "../d1-thread-metadata-store";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

let worker: Miniflare;
let options: MiniflareOptions;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "yo-chat-d1-"));
  // This bundle intentionally has no Node compatibility flags or Node externals.
  const bundle = await build({
    entryPoints: [new URL("../../server/thread-metadata-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    external: ["cloudflare:workers", "node:process"],
  });
  options = {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "metadata",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0].text } },
          },
          env: { THREAD_METADATA: { type: "d1", id: "thread-metadata" } },
        },
      },
    ],
  };
  worker = new Miniflare(options);
  await worker.ready;
  const db = await worker.getD1Database("THREAD_METADATA");
  const schema = await readFile(
    new URL("../../../schema/thread-metadata.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    schema
      .split(";")
      .filter((s) => s.trim())
      .map((s) => db.prepare(s)),
  );
});
afterAll(async () => {
  await worker?.dispose();
  await rm(directory, { recursive: true, force: true });
});

function request(path: string, method = "GET", body?: unknown) {
  return worker.dispatchFetch(`http://metadata/api/threaded-chat/threads${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("D1 thread metadata HTTP storage", () => {
  it("preserves normalized metadata and namespace isolation across workerd replacement", async () => {
    const created = await request("", "POST", {
      id: "persisted",
      namespace: "  flight  ",
      title: "  Pick   a flight ",
      messageCount: 2.9,
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      thread: { id: "persisted", namespace: "flight", title: "Pick a flight", messageCount: 2 },
    });
    await request("", "POST", { id: "other", namespace: "cards" });
    await worker.dispose();
    worker = new Miniflare(options);
    await worker.ready;
    const list = await request("?namespace=flight");
    expect(await list.json()).toMatchObject({
      threads: [{ id: "persisted", title: "Pick a flight" }],
    });
    expect((await request("/persisted")).status).toBe(200);
  });
  it("preserves disjoint concurrent updates without replacing omitted fields", async () => {
    await request("", "POST", { id: "updates", title: "Original", messageCount: 1 });
    const responses = await Promise.all([
      request("/updates", "PATCH", { title: "Updated title" }),
      request("/updates", "PATCH", { messageCount: 7, lastMessagePreview: "  Selected   2A " }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await (await request("/updates")).json()).toMatchObject({
      thread: {
        title: "Updated title",
        messageCount: 7,
        lastMessagePreview: "Selected 2A",
      },
    });
  });
  it("supports stable PUT identity, deletion and missing-row responses", async () => {
    expect((await request("/put-id", "PUT", { namespace: "cards", title: "First" })).status).toBe(
      201,
    );
    expect((await request("/put-id", "PUT", { title: "Second" })).status).toBe(200);
    expect(await (await request("/put-id")).json()).toMatchObject({
      thread: { id: "put-id", namespace: "cards", title: "Second" },
    });
    expect((await request("/put-id", "DELETE")).status).toBe(204);
    expect((await request("/put-id")).status).toBe(404);
    expect((await request("/put-id", "PATCH", { title: "Missing" })).status).toBe(404);
    expect((await request("/put-id", "DELETE")).status).toBe(404);
  });
});

it("bounds first and deep thread pages, including timestamp ties, independent of table size", async () => {
  const db = (await worker.getD1Database("THREAD_METADATA")) as unknown as D1Database;
  const meter = meterD1(db);
  const store = createD1ThreadMetadataStore(meter.database);
  for (const count of [100, 10000]) {
    await db
      .prepare(
        `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?) INSERT OR IGNORE INTO thread_metadata(id,namespace,title,created_at,updated_at,last_message_preview,message_count) SELECT printf('cost-%05d',x),'cost','Test',100,100,'Test',0 FROM n`,
      )
      .bind(count)
      .run();
    meter.queries.length = 0;
    const first = await store.list("cost", { limit: 10 });
    expect(first).toHaveLength(10);
    const second = await store.list("cost", {
      limit: 10,
      before: { updatedAt: first[9].updatedAt, id: first[9].id },
    });
    expect(second).toHaveLength(10);
    expect(new Set([...first, ...second].map((thread) => thread.id)).size).toBe(20);
    // A cursor near the end must seek past thousands of tied timestamps.
    const deep = await store.list("cost", {
      limit: 10,
      before: { updatedAt: 100, id: "cost-00012" },
    });
    expect(deep.map((thread) => thread.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `cost-${String(11 - i).padStart(5, "0")}`),
    );
    await store.list(undefined, { limit: 10 });
    await store.list(undefined, { limit: 10, before: { updatedAt: 100, id: "cost-00012" } });
    expect(await store.list("absent", { limit: 10 })).toEqual([]);
    for (const query of meter.queries) {
      expect(query.rowsRead).toBeLessThanOrEqual(25);
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
        .bind(...query.bindings)
        .all<{ detail: string }>();
      expect(plan.results.map((row) => row.detail).join("\n")).not.toMatch(
        /USE TEMP B-TREE|SCAN thread_metadata(?! USING INDEX)/,
      );
    }
    console.info(
      JSON.stringify({
        scenario: "six-thread-pages",
        records: count,
        rowsRead: meter.queries.map((query) => query.rowsRead),
      }),
    );
  }
  const response = await request("?namespace=cost&limit=10");
  const firstPage = (await response.json()) as { threads: { id: string }[]; nextCursor: string };
  expect(firstPage.threads).toHaveLength(10);
  const next = await request(
    `?namespace=cost&limit=10&before=${encodeURIComponent(firstPage.nextCursor)}`,
  );
  const nextPage = (await next.json()) as { threads: { id: string }[] };
  expect(nextPage.threads).toHaveLength(10);
  expect(new Set([...firstPage.threads, ...nextPage.threads].map((thread) => thread.id)).size).toBe(
    20,
  );
  for (const query of ["limit=0", "limit=101", "limit=NaN", "before=null", "before=%7B%7D"])
    expect((await request(`?${query}`)).status).toBe(400);
});
