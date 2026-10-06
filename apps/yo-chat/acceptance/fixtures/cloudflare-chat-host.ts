import { builtinModules } from "node:module";
import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { initializeD1Storage } from "@sweatpants/storage-d1";
import type { TestModelInstallation } from "@sweatpants/test-rig";

export async function startCloudflareChatHost(model: TestModelInstallation) {
  const directory = await mkdtemp(join(tmpdir(), "yo-chat-worker-"));
  const bundle = async (path: string) =>
    (
      await build({
        entryPoints: [new URL(path, import.meta.url).pathname],
        bundle: true,
        write: false,
        banner: {
          js: 'import { createRequire as fixtureCreateRequire } from "node:module"; const require = fixtureCreateRequire("file:///worker.js");',
        },
        format: "esm",
        platform: "browser",
        conditions: ["development"],
        external: ["cloudflare:workers", "node:*"],
        define: { "import.meta.url": JSON.stringify("file:///worker.js") },
        alias: Object.fromEntries(
          builtinModules
            .filter((name) => !name.startsWith("node:"))
            .map((name) => [name, `node:${name}`]),
        ),
      })
    ).outputFiles[0]!.text;
  const [host, executor] = await Promise.all([
    bundle("./cloudflare-chat-worker.ts"),
    bundle("../../src/server/cloudflare-tool-executor.ts"),
  ]);
  const options: MiniflareOptions = {
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "yo-chat-host",
          compatibilityDate: "2026-10-05",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: host } },
          },
          exports: {
            ResponseStream: { type: "durable-object", storage: "sqlite" },
            ToolSessions: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            JOURNAL: { type: "d1", id: "journal" },
            THREAD_METADATA: { type: "d1", id: "metadata" },
            RESPONSE_STREAMS: {
              type: "durable-object",
              worker: "yo-chat-host",
              exportName: "ResponseStream",
            },
            TOOL_SESSIONS: {
              type: "durable-object",
              worker: "yo-chat-host",
              exportName: "ToolSessions",
            },
            LOADER: { type: "worker-loader" },
            CODE: { type: "text", value: executor },
            MODEL: {
              type: "text",
              value: JSON.stringify({ model: model.model, streamOptions: model.streamOptions }),
            },
            PROGRAM_DRIVER_CAPABILITY_SECRET: {
              type: "text",
              value: "worker-host-test-secret-at-least-32-bytes",
            },
          },
        },
      },
    ],
  };
  let worker = new Miniflare(options);
  try {
    await worker.ready;
    await initializeD1Storage((await worker.getD1Database("JOURNAL")) as unknown as D1Database);
  } catch (error) {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    async handle(request: Request): Promise<Response> {
      return (await worker.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.text() : undefined,
        signal: request.signal,
      })) as unknown as Response;
    },
    async replace() {
      await worker.dispose();
      worker = new Miniflare(options);
      await worker.ready;
    },
    async close() {
      await worker.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
