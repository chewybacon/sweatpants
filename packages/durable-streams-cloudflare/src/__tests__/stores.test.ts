import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { run, sleep } from "effection";
import { createPullStream } from "@sweatpants/durable-streams";
import { defineTokenBufferStoreConformance } from "../../../durable-streams/src/__tests__/token-buffer-store-conformance.ts";
import { createCloudflareResponseStores } from "../index.ts";
import type { ResponseStreamNamespace, ResponseStreamRpc } from "../protocol.ts";
let worker: Miniflare;
let options: MiniflareOptions;
let directory: string;
let workerSource: string;
let namespace: ResponseStreamNamespace;
let calls: string[] = [];
let pending = 0;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "cf-response-streams-"));
  const bundle = await build({
    entryPoints: [new URL("./fixtures/worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    external: ["cloudflare:workers", "node:process"],
  });
  workerSource = bundle.outputFiles[0]!.text;
  options = {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "streams",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
          },
          exports: { ResponseStream: { type: "durable-object", storage: "sqlite" } },
          env: {
            STREAMS: { type: "durable-object", worker: "streams", exportName: "ResponseStream" },
          },
        },
      },
    ],
  };
  worker = new Miniflare(options);
  await worker.ready;
  namespace = {
    getByName(id) {
      // Native Worker -> DO RPC exercises the actual boundary. The HTTP bridge
      // avoids Miniflare's Node proxy limitations; it is test-only, not public ingress.
      return new Proxy({} as ResponseStreamRpc, {
        get(_target, method: string) {
          return async (...args: unknown[]) => {
            calls.push(method);
            pending++;
            try {
              const response = await worker.dispatchFetch("http://streams/rpc", {
                method: "POST",
                body: JSON.stringify({ id, method, args }),
              });
              if (!response.ok) throw new Error(await response.text());
              return await response.json();
            } finally {
              pending--;
            }
          };
        },
      });
    },
  };
});
afterAll(async () => {
  await worker?.dispose();
  await rm(directory, { recursive: true, force: true });
});
const stores = () => createCloudflareResponseStores<string>(namespace);
defineTokenBufferStoreConformance("cloudflare", () => stores().bufferStore);

describe("Durable Object delivery state", () => {
  it("bundles without Node runtime imports", () => {
    expect(workerSource).not.toContain("node:process");
  });
  it("preserves buffers, terminal state and registry entries across workerd replacement", async () => {
    const first = stores();
    const buffer = await run(() => first.bufferStore.create("restart"));
    const writer = await run(() => buffer.claimWriter({ ownerId: "before", activationEpoch: 1 }));
    await run(() => writer.append(["a", "b"]));
    await run(() => first.registryStore.set("restart", { refCount: 2, createdAt: 123 }));
    await worker.dispose();
    worker = new Miniflare(options);
    await worker.ready;
    const replacement = stores();
    const restored = await run(() => replacement.bufferStore.get("restart"));
    expect(restored).not.toBeNull();
    expect(await run(() => restored!.read(1, 1))).toEqual({ tokens: ["b"], lsn: 2 });
    expect(await run(() => replacement.registryStore.get("restart"))).toEqual({
      refCount: 2,
      createdAt: 123,
    });
    const newer = await run(() => restored!.claimWriter({ ownerId: "after", activationEpoch: 2 }));
    await expect(run(() => writer.append(["stale"]))).rejects.toMatchObject({
      code: "stale_token_writer",
    });
    await run(() => newer.complete());
    await worker.dispose();
    worker = new Miniflare(options);
    await worker.ready;
    expect(await run(() => restored!.isComplete())).toBe(true);
    expect(await run(() => restored!.readLatest!())).toEqual({ token: "b", lsn: 2 });
  });
  it("admits only one owner at an equal activation epoch", async () => {
    const buffer = await run(() => stores().bufferStore.create("owners"));
    const results = await Promise.allSettled(
      ["a", "b"].map((ownerId) => run(() => buffer.claimWriter({ ownerId, activationEpoch: 1 }))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "stale_token_writer",
    });
  });
  it("rolls back an entire append when a later token violates storage constraints", async () => {
    const buffer = await run(() => stores().bufferStore.create("rollback"));
    const fence = { ownerId: "owner", activationEpoch: 1 };
    await run(() => buffer.claimWriter(fence));
    // Inject a bad wire value after a valid row to fail inside the transaction.
    const reply = await namespace
      .getByName("rollback")
      .append(fence, [JSON.stringify("partial"), null as unknown as string]);
    expect(reply.ok).toBe(false);
    expect(await run(() => buffer.read())).toEqual({ tokens: [], lsn: 0 });
  });
  it("deletes buffer and registry state through their independent ports", async () => {
    const first = stores();
    await run(() => first.bufferStore.create("delete"));
    await run(() => first.registryStore.set("delete", { refCount: 0, createdAt: 123 }));
    await run(() => first.bufferStore.delete("delete"));
    expect(await run(() => first.bufferStore.get("delete"))).toBeNull();
    expect(await run(() => first.registryStore.get("delete"))).not.toBeNull();
    await run(() => first.registryStore.delete("delete"));
    expect(await run(() => first.registryStore.get("delete"))).toBeNull();
  });
  it("updates reference counts atomically across independent clients", async () => {
    await run(() => stores().registryStore.set("references", { refCount: 0, createdAt: 123 }));
    const counts = await Promise.all(
      Array.from({ length: 20 }, () =>
        run(() => stores().registryStore.updateRefCount("references", 1)),
      ),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await run(() => stores().registryStore.get("references"))).toEqual({
      refCount: 20,
      createdAt: 123,
    });
  });
  it("only reads on pull and lets a slow reader drain bounded batches independently", async () => {
    const buffer = await run(() => stores().bufferStore.create("lazy"));
    const writer = await run(() => buffer.claimWriter({ ownerId: "owner", activationEpoch: 1 }));
    await run(() => writer.append(Array.from({ length: 600 }, (_, i) => String(i))));
    await run(() => writer.complete());
    await run(function* () {
      const slow = yield* createPullStream(buffer);
      calls = [];
      yield* sleep(20);
      expect(calls).toEqual([]);
      expect(yield* slow.next()).toEqual({ done: false, value: { token: "0", lsn: 1 } });
      expect(calls.filter((c) => c === "read")).toHaveLength(1);
      const fast = yield* createPullStream(buffer, 599);
      expect(yield* fast.next()).toEqual({ done: false, value: { token: "599", lsn: 600 } });
      const reads = calls.filter((c) => c === "read").length;
      for (let i = 1; i < 256; i++)
        expect(yield* slow.next()).toEqual({
          done: false,
          value: { token: String(i), lsn: i + 1 },
        });
      expect(calls.filter((c) => c === "read")).toHaveLength(reads);
      expect(yield* slow.next()).toEqual({ done: false, value: { token: "256", lsn: 257 } });
      expect(calls.filter((c) => c === "read")).toHaveLength(reads + 1);
    });
  });
  it("cancels a remote wait when the pulling reader is cancelled", async () => {
    const buffer = await run(() => stores().bufferStore.create("cancel"));
    const reader = run(() => buffer.waitForChange(0));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toContain("waitForChange");
    await reader.halt();
    expect(calls).toContain("cancelWait");
    calls = [];
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toEqual([]);
    expect(pending).toBe(0);
  });
});
