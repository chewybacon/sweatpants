import { createChatFetchHandler, type ChatModel } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import { DurableObject } from "cloudflare:workers";
import {
  createCloudflareChatRouter,
  chatHostPlacement,
  type ConversationNamespace,
} from "../../src/server/cloudflare-chat-placement";
import {
  createCloudflareChatApplication,
  type CloudflareChatBindings,
} from "../../src/server/cloudflare-chat-host";
export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
export { ToolSessions } from "../../src/server/cloudflare-tool-sessions";

interface Env extends CloudflareChatBindings {
  MODEL: string;
  CONVERSATIONS: ConversationNamespace;
  CHAT_HOST_PLACEMENT: string;
}
function handle(request: Request, env: Env) {
  const configured = JSON.parse(env.MODEL) as Pick<ChatModel, "model" | "streamOptions">;
  return createChatFetchHandler(() =>
    createCloudflareChatApplication(env, {
      ...configured,
      driver: createPiAiModelProvider().driver,
    }),
  )(request);
}
export class Conversations extends DurableObject<Env> {
  override fetch(request: Request) {
    return handle(request, this.env);
  }
}
export default {
  fetch(request: Request, env: Env) {
    return createCloudflareChatRouter({
      placement: chatHostPlacement(env.CHAT_HOST_PLACEMENT),
      conversations: env.CONVERSATIONS,
      worker: (input) => handle(input, env),
    })(request);
  },
};

export { ToolExecutors } from "../../src/server/cloudflare-tool-objects";
