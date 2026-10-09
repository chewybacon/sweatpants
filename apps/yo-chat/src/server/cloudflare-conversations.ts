import { DurableObject } from "cloudflare:workers";
import { createChatFetchHandler } from "@sweatpants/agent-host/server";
import { createCloudflareApplication, type CloudflareChatEnv } from "./cloudflare-chat-application";
import { withDefaultSystemPrompt } from "./default-system-prompt";

/** Named conversation placement; each response still owns its Effection scope.
 * D1 remains authoritative, so eviction requires no in-memory recovery protocol.
 */
export class Conversations extends DurableObject<CloudflareChatEnv> {
  override async fetch(request: Request): Promise<Response> {
    const handler = createChatFetchHandler(() => createCloudflareApplication(this.env));
    return handler(await withDefaultSystemPrompt(request));
  }
}
