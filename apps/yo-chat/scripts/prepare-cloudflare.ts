import { getPlatformProxy } from "wrangler";
import { initializeD1Storage } from "@sweatpants/storage-d1";
import type { D1Database } from "@cloudflare/workers-types";
import { spawnSync } from "node:child_process";

const migration = spawnSync(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "THREAD_METADATA",
    "--local",
    "--persist-to",
    ".wrangler/worker-state",
  ],
  { stdio: "inherit" },
);
if (migration.status !== 0) throw new Error("Cloudflare metadata initialization failed");
const platform = await getPlatformProxy<{ JOURNAL: D1Database }>({
  configPath: "wrangler.jsonc",
  persist: { path: ".wrangler/worker-state/v3" },
});
try {
  await initializeD1Storage(platform.env.JOURNAL);
} finally {
  await platform.dispose();
}
console.log("Local Cloudflare storage ready");
