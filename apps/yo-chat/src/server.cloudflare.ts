import handler from "@tanstack/react-start/server-entry";
import type { CloudflareChatEnv } from "./server/cloudflare-chat-application";
import { createCloudflareApplication } from "./server/cloudflare-chat-application";
import { createChatFetchHandler } from "@sweatpants/agent-host/server";
import { chatHostPlacement, createCloudflareChatRouter } from "./server/cloudflare-chat-placement";
import { withDefaultSystemPrompt } from "./server/default-system-prompt";
import { createD1ThreadMetadataStore } from "./lib/d1-thread-metadata-store";
import { handleThreadMetadataRequest } from "./lib/thread-metadata-api";
export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
export { ToolSessions } from "./server/cloudflare-tool-sessions";
export { Conversations } from "./server/cloudflare-conversations";

export default {
  async fetch(request: Request, env: CloudflareChatEnv) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/chat" || pathname.startsWith("/api/chat/")) {
      return createCloudflareChatRouter({
        placement: chatHostPlacement(env.CHAT_HOST_PLACEMENT),
        conversations: env.CONVERSATIONS,
        worker: async (input) =>
          createChatFetchHandler(() => createCloudflareApplication(env))(
            await withDefaultSystemPrompt(input),
          ),
      })(request);
    }
    if (new URL(request.url).pathname.startsWith("/api/threaded-chat/threads")) {
      return handleThreadMetadataRequest(request, createD1ThreadMetadataStore(env.THREAD_METADATA));
    }
    return handler.fetch(request);
  },
};

export { ToolExecutors } from "./server/cloudflare-tool-objects";
