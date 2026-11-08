import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let worker: Miniflare;

beforeAll(async () => {
  const bundle = await build({
    entryPoints: [new URL("./fixtures/readable-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    // Effection main() lazily imports node:process; it is never called here.
    external: ["node:process"],
  });
  worker = new Miniflare({
    workers: [
      {
        config: {
          name: "readable",
          compatibilityDate: "2026-10-05",
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: bundle.outputFiles[0]!.text } },
          },
        },
      },
    ],
  } as never);
}, 30_000);

afterAll(() => worker?.dispose());

describe.each(["effect", "effection"])("workerd %s", (runtime) => {
  it("streams a lazy Response body whose delivered text matches the produced deltas", async () => {
    const response = await worker.dispatchFetch(`http://local/?runtime=${runtime}&mode=fast`);
    const lines = (await response.text()).split("\n").filter(Boolean);
    expect(lines.join("")).toBe("Hello, world");
  });

  it("a slow in-worker reader receives compacted frames", async () => {
    const response = await worker.dispatchFetch(`http://local/slow-consumer?runtime=${runtime}`);
    const frames = (await response.json()) as string[];
    expect(frames.join("")).toBe("Hello, world");
    expect(frames.length).toBeLessThan(5);
  });

  it("client disconnect halts the reader and runs its cleanup", async () => {
    const response = await worker.dispatchFetch(`http://local/?runtime=${runtime}&mode=slow`);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    let released: Record<string, boolean> = {};
    for (let attempt = 0; attempt < 50; attempt++) {
      released = (await (await worker.dispatchFetch("http://local/released")).json()) as never;
      if (released[`${runtime}:slow`]) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(released[`${runtime}:slow`]).toBe(true);
  });
});
