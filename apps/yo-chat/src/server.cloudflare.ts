import handler from "@tanstack/react-start/server-entry";
import type { CloudflareChatEnv } from "./server/cloudflare-chat-application";
import { createD1ThreadMetadataStore } from "./lib/d1-thread-metadata-store";
import { handleThreadMetadataRequest } from "./lib/thread-metadata-api";
export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
export { ToolSessions } from "./server/cloudflare-tool-sessions";

export default {
  async fetch(request: Request, env: CloudflareChatEnv) {
    if (new URL(request.url).pathname.startsWith("/api/threaded-chat/threads")) {
      return handleThreadMetadataRequest(request, createD1ThreadMetadataStore(env.THREAD_METADATA));
    }
    return handler.fetch(request);
  },
};
