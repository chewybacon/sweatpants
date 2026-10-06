export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1ThreadMetadataStore } from "../lib/d1-thread-metadata-store";
import { handleThreadMetadataRequest } from "../lib/thread-metadata-api";

export default {
  fetch(request: Request, env: { THREAD_METADATA: D1Database }): Promise<Response> {
    return handleThreadMetadataRequest(request, createD1ThreadMetadataStore(env.THREAD_METADATA));
  },
};
