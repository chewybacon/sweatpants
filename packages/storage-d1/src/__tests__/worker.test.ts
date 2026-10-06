import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { expect, it } from "vitest";
it("runs without Node compatibility and survives replacement of workerd", async () => {
  const directory = await mkdtemp(join(tmpdir(), "d1-journal-"));
  const bundle = await build({
    entryPoints: [new URL("./fixtures/worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:process"],
    conditions: ["development"],
  });
  // Effection's unused CLI entry references node:process; tree shaking must
  // remove it entirely from this Worker, which has no Node compatibility flag.
  expect(bundle.outputFiles[0]!.text).not.toContain("node:process");
  const options: MiniflareOptions = {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "journal",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
          },
          env: { JOURNAL: { type: "d1", id: "journal" } },
        },
      },
    ],
  };
  let worker = new Miniflare(options);
  try {
    expect(
      await (await worker.dispatchFetch("http://journal/", { method: "POST" })).json(),
    ).toEqual([4, 2]);
    await worker.dispose();
    worker = new Miniflare(options);
    expect(await (await worker.dispatchFetch("http://journal/")).json()).toEqual([4, 2]);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
