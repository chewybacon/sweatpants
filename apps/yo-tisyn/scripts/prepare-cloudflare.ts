import { withWranglerEnv } from "@sweatpants/cloudflare-tasks";
import { initializeD1Storage } from "@sweatpants/storage-d1";
import type { D1Database } from "@cloudflare/workers-types";

const remote = process.argv.includes("--remote");
await withWranglerEnv<{ JOURNAL: D1Database }>(
  {
    config: "wrangler.tasks.jsonc",
    persistTo: process.env.TISYN_LOCAL_STATE_PATH ?? ".wrangler/worker-state",
    environment: remote ? "production" : undefined,
    remoteBindings: remote,
  },
  async (env) => {
    await initializeD1Storage(env.JOURNAL);
  },
);
console.log(`yo-tisyn ${remote ? "remote" : "local"} D1 ready`);
