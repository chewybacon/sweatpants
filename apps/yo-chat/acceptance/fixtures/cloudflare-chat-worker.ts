import { createChatFetchHandler, type ChatModel } from "@sweatpants/agent-host/server";
import { createPiAiModelProvider } from "@sweatpants/model-provider-pi-ai";
import {
  createCloudflareChatApplication,
  type CloudflareChatBindings,
} from "../../src/server/cloudflare-chat-host";
export { ResponseStream } from "@sweatpants/durable-streams-cloudflare/worker";
export { ToolSessions } from "../../src/server/cloudflare-tool-sessions";

interface Env extends CloudflareChatBindings {
  MODEL: string;
}
export default {
  fetch(request: Request, env: Env) {
    const configured = JSON.parse(env.MODEL) as Pick<ChatModel, "model" | "streamOptions">;
    return createChatFetchHandler(() =>
      createCloudflareChatApplication(env, {
        ...configured,
        driver: createPiAiModelProvider().driver,
      }),
    )(request);
  },
};

export { ToolExecutors } from "../../src/server/cloudflare-tool-objects";
