import { createServer } from "node:net";
import { promisify } from "node:util";
import { startWorkerCpuProfile } from "./worker-cpu-profile";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const profileDirectory = process.env.YO_CHAT_CPU_PROFILE_DIRECTORY;
  const frozenBundle = process.env.YO_CHAT_CPU_PROFILE_BUNDLE;
  if (frozenBundle && !profileDirectory) {
    throw new Error("Frozen worker bundles are only supported during CPU profiling");
  }
  const host = frozenBundle
    ? await readFile(frozenBundle, "utf8")
    : await bundle("./cloudflare-chat-worker.ts");
  // Reserve an available inspector port; simultaneous benchmark runs stay isolated.
  let inspectorPort: number | undefined;
  if (profileDirectory) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing inspector port");
    }
    inspectorPort = address.port;
    await promisify(server.close.bind(server))();
    await writeFile(join(profileDirectory, "worker.js"), host);
  }
  const workerModule = { type: "esm" as const, contents: host };
  let clockOffsetMs = 0;
  const options: MiniflareOptions = {
    inspectorPort,
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name: "yo-chat-host",
          compatibilityDate: "2026-10-05",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: { "index.js": workerModule },
          },
          exports: {
            ToolExecutors: { type: "durable-object", storage: "sqlite" },
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
            TOOL_EXECUTORS: {
              type: "durable-object",
              worker: "yo-chat-host",
              exportName: "ToolExecutors",
            },
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
  let stopProfile: (() => Promise<void>) | undefined;
  try {
    await worker.ready;
    const database = (await worker.getD1Database("JOURNAL")) as unknown as D1Database;
    const frozenSchema = process.env.YO_CHAT_CPU_PROFILE_SCHEMA;
    if (frozenSchema) {
      if (!frozenBundle || !profileDirectory)
        throw new Error("Frozen schema requires a frozen CPU profile bundle");
      const statements: string[] = JSON.parse(await readFile(frozenSchema, "utf8"));
      await database.batch(statements.map((sql) => database.prepare(sql)));
    } else {
      await initializeD1Storage(database);
    }
    if (profileDirectory) {
      stopProfile = await startWorkerCpuProfile(
        worker,
        join(profileDirectory, "initial.cpuprofile"),
      );
    }
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
    async replace({ elapsedMs = 0 }: { elapsedMs?: number } = {}) {
      try {
        await stopProfile?.();
      } finally {
        stopProfile = undefined;
        await worker.dispose();
      }
      // Simulate downtime after a crashed host without sleeping through leases.
      // This clock exists only in the bundled Test Rig Worker.
      clockOffsetMs += elapsedMs;
      workerModule.contents =
        clockOffsetMs === 0
          ? host
          : `const fixtureNow = Date.now; Date.now = () => fixtureNow() + ${clockOffsetMs};\n${host}`;
      worker = new Miniflare(options);
      await worker.ready;
      if (profileDirectory) {
        stopProfile = await startWorkerCpuProfile(
          worker,
          join(profileDirectory, "restarted.cpuprofile"),
        );
      }
    },
    async close() {
      try {
        await stopProfile?.();
      } finally {
        try {
          await worker.dispose();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
