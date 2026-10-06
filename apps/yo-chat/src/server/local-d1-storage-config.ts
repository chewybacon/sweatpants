import {
  createCloudflareResponseStores,
  type ResponseStreamNamespace,
} from "@sweatpants/durable-streams-cloudflare";
import { getPlatformProxy } from "wrangler";
import { createD1Storage, initializeD1Storage } from "@sweatpants/storage-d1";
import type { D1Database } from "@cloudflare/workers-types";

// Vite's d1-local mode selects this composition module. The journal binding runs
// in local workerd; the application host and its model provider remain in Node.
const platform = await getPlatformProxy<{
  JOURNAL: D1Database;
  RESPONSE_STREAMS: ResponseStreamNamespace;
}>({
  configPath: new URL("../../wrangler.journal.jsonc", import.meta.url).pathname,
});
await initializeD1Storage(platform.env.JOURNAL);
if (import.meta.hot) import.meta.hot.dispose(() => platform.dispose());

export function createYoChatStorageConfig() {
  return createD1Storage(platform.env.JOURNAL);
}

export const responseStores = createCloudflareResponseStores<string>(platform.env.RESPONSE_STREAMS);
