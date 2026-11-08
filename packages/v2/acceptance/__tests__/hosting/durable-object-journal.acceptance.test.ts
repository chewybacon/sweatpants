import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let code: string;
const directory = mkdtempSync(join(tmpdir(), "sweatpants-do-"));

function start() {
  return new Miniflare({
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "conversations",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: code } },
          },
          exports: { Conversation: { type: "durable-object", storage: "sqlite" } },
          env: {
            CONVERSATIONS: {
              type: "durable-object",
              worker: "conversations",
              exportName: "Conversation",
            },
          },
        },
      },
    ],
  } as never);
}

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL("./fixtures/durable-object-journal.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    // Effection main() lazily imports node:process; it is never called here.
    external: ["cloudflare:workers", "node:process"],
  });
  code = bundle.outputFiles[0]!.text;
}, 30_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe.each(["effect", "effection"])("Durable Object journal under %s", (runtime) => {
  it("parks, survives an object restart, accepts an answer and completes without redelivery", async () => {
    const id = `${runtime}-${crypto.randomUUID()}`;
    async function call(worker: Miniflare, path: string) {
      const response = await worker.dispatchFetch(
        `http://local${path}${path.includes("?") ? "&" : "?"}runtime=${runtime}&id=${id}`,
      );
      const body = await response.text();
      if (!response.ok) {
        throw new Error(body);
      }
      return JSON.parse(body) as unknown;
    }
    let worker = start();
    try {
      await call(worker, "/admit?input=research");
      expect(await call(worker, "/run")).toEqual({ state: "waiting" });
      expect(await call(worker, "/run")).toEqual({ state: "waiting" });
    } finally {
      await worker.dispose();
    }
    worker = start();
    try {
      expect(await call(worker, "/read")).toEqual({ status: "running", deliveries: 1 });
      await call(worker, "/answer?value=yes");
      expect(await call(worker, "/run")).toEqual({ state: "completed", value: "finding:yes" });
      expect(await call(worker, "/read")).toEqual({ status: "completed", deliveries: 1 });
    } finally {
      await worker.dispose();
    }
  });
});
