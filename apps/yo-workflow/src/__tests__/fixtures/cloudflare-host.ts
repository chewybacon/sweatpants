import { builtinModules, createRequire } from "node:module";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { initializeD1Storage } from "@sweatpants/storage-d1";
import type { TestModelInstallation } from "@sweatpants/test-rig";

export async function startCloudflareHost(model: TestModelInstallation, installEvaluation = true) {
  const directory = await mkdtemp(join(tmpdir(), "yo-workflow-cloudflare-"));
  const bundle = await build({
    entryPoints: [new URL("./cloudflare-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "development"],
    external: [
      "cloudflare:workers",
      "node:*",
      "scheme-kernel.wasm",
      "scheme-reflect.wasm",
      "scheme-wtf8.wasm",
      "execution-lua.wasm",
    ],
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire("file:///worker.js");',
    },
    define: { "import.meta.url": JSON.stringify("file:///worker.js") },
    alias: {
      ...Object.fromEntries(
        builtinModules
          .filter((name) => !name.startsWith("node:"))
          .map((name) => [name, `node:${name}`]),
      ),
      "#execution-lua-wasm": "execution-lua.wasm",
      "#scheme-kernel-wasm": "scheme-kernel.wasm",
      "#scheme-reflect-wasm": "scheme-reflect.wasm",
      "#scheme-wtf8-wasm": "scheme-wtf8.wasm",
    },
  });
  const options: MiniflareOptions = {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "yo-workflow-test",
          compatibilityDate: "2026-10-05",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: bundle.outputFiles[0].text },
              "execution-lua.wasm": {
                type: "wasm",
                contents: await readFile(
                  new URL(
                    "../../../../../.artifacts/teal-lua-checkpoint/kernel.wasm",
                    import.meta.url,
                  ),
                ),
              },
              ...Object.fromEntries(
                await Promise.all(
                  ["kernel", "reflect", "wtf8"].map(async (name) => [
                    `scheme-${name}.wasm`,
                    {
                      type: "wasm" as const,
                      contents: await readFile(
                        createRequire(import.meta.url).resolve(`#scheme-${name}-wasm`),
                      ),
                    },
                  ]),
                ),
              ),
            },
          },
          exports: {
            Conversations: { type: "durable-object", storage: "sqlite" },
            ToolExecutors: { type: "durable-object", storage: "sqlite" },
            UnconfiguredToolExecutors: { type: "durable-object", storage: "sqlite" },
            ResponseStream: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            CONVERSATIONS: {
              type: "durable-object",
              worker: "yo-workflow-test",
              exportName: "Conversations",
            },
            TOOL_EXECUTORS: {
              type: "durable-object",
              worker: "yo-workflow-test",
              exportName: installEvaluation ? "ToolExecutors" : "UnconfiguredToolExecutors",
            },
            RESPONSE_STREAMS: {
              type: "durable-object",
              worker: "yo-workflow-test",
              exportName: "ResponseStream",
            },
            JOURNAL: { type: "d1", id: "journal" },
            MODEL: {
              type: "text",
              value: JSON.stringify({ model: model.model, streamOptions: model.streamOptions }),
            },
            PROGRAM_DRIVER_CAPABILITY_SECRET: {
              type: "text",
              value: "yo-workflow-cloudflare-test-secret-not-for-deployment",
            },
          },
        },
      },
    ],
  };
  let worker = new Miniflare(options);
  try {
    await worker.ready;
    await initializeD1Storage(await worker.getD1Database("JOURNAL"));
  } catch (error) {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    async handle(request: Request): Promise<Response> {
      const response = (await worker.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.text() : undefined,
        signal: request.signal,
      })) as unknown as Response;
      return response;
    },
    async replace() {
      await worker.dispose();
      worker = new Miniflare(options);
      await worker.ready;
    },
    async close() {
      try {
        await worker.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
