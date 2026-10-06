import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import type {
  ToolExecutorEntrypoint,
  ToolExecutorRpc,
  ToolSessionNamespace,
  ToolSessionRpc,
} from "@sweatpants/tool-runtime-cloudflare";

/** Real workerd lifecycle; replacing it discards every live generator and RPC session. */
export async function startCloudflareExecutor() {
  const bundle = await build({
    entryPoints: [
      new URL("../../src/server/cloudflare-tool-executor.ts", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["development"],
    external: ["cloudflare:workers", "node:*"],
  });
  const host = await build({
    entryPoints: [new URL("./cloudflare-tool-worker.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    conditions: ["development"],
  });
  const options: MiniflareOptions = {
    workers: [
      {
        config: {
          name: "yo-chat-tools",
          compatibilityDate: "2026-10-05",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": { type: "esm", contents: host.outputFiles[0].text } },
          },
          exports: { ToolSessions: { type: "durable-object", storage: "sqlite" } },
          env: {
            SESSIONS: {
              type: "durable-object",
              worker: "yo-chat-tools",
              exportName: "ToolSessions",
            },
            LOADER: { type: "worker-loader" },
            CODE: { type: "text", value: bundle.outputFiles[0].text },
          },
        },
      },
    ],
  };
  let worker = new Miniflare(options);
  await worker.ready;
  const entrypoint: ToolExecutorEntrypoint = {
    async createExecutor() {
      // Node's Miniflare proxy cannot forward symbol methods; disposal runs on
      // the genuine stub inside workerd through this explicit test-only bridge.
      const host = await worker.getWorker();
      const proxy = await (
        host as unknown as {
          createExecutor(): Promise<
            Omit<ToolExecutorRpc, typeof Symbol.dispose> & { dispose(): Promise<void> }
          >;
        }
      ).createExecutor();
      return {
        attach: (request) => proxy.attach(request),
        step: (id, command) => proxy.step(id, command),
        shutdown: (id, reason) => proxy.shutdown(id, reason),
        [Symbol.dispose]: () => proxy.dispose(),
      };
    },
  };

  let namespace = await worker.getDurableObjectNamespace("SESSIONS");
  const sessions: ToolSessionNamespace = {
    getByName(name) {
      return namespace.get(namespace.idFromName(name)) as unknown as ToolSessionRpc;
    },
  };
  return {
    sessions,
    worker: entrypoint,
    async replace() {
      await worker.dispose();
      worker = new Miniflare(options);
      await worker.ready;
      namespace = await worker.getDurableObjectNamespace("SESSIONS");
    },
    async close() {
      await worker.dispose();
    },
  };
}
