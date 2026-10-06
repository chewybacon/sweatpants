import { withWranglerEnv } from "@sweatpants/cloudflare-tasks";
import { initializeD1Storage } from "@sweatpants/storage-d1";
import type { D1Database } from "@cloudflare/workers-types";
import { spawnSync } from "node:child_process";

const initialization = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "THREAD_METADATA",
    "--local",
    "--file",
    "schema/thread-metadata.sql",
    "--persist-to",
    ".wrangler/worker-state",
  ],
  { stdio: "inherit" },
);
if (initialization.status !== 0) {
  throw new Error("Cloudflare metadata initialization failed");
}
await withWranglerEnv<{ JOURNAL: D1Database }, void>(
  { config: "wrangler.tasks.jsonc", persistTo: ".wrangler/worker-state" },
  async (env) => {
    await initializeD1Storage(env.JOURNAL);
  },
);
console.log("Local Cloudflare storage ready");
