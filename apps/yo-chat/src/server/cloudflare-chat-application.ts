import { env } from "cloudflare:workers";
import { createChatFetchHandler } from "@sweatpants/agent-host/server";
import { pi } from "@sweatpants/model-provider-pi-ai";
import { InMemoryCredentialStore, type Credential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { createYoChatModels } from "./model-catalog";
import {
  createCloudflareChatApplication,
  type CloudflareChatBindings,
} from "./cloudflare-chat-host";
import type { ConversationNamespace } from "./cloudflare-chat-placement";
export { withDefaultSystemPrompt } from "./default-system-prompt";

// Pi’s bundled-flow entry replaces filesystem dynamic imports in bundled runtimes.
registerBunOAuthFlows();

export interface CloudflareChatEnv extends CloudflareChatBindings {
  CONVERSATIONS: ConversationNamespace;
  CHAT_HOST_PLACEMENT?: string;
  MODEL_CREDENTIALS: string;
  DEFAULT_CHAT_MODEL_PROVIDER: string;
  DEFAULT_CHAT_MODEL_ID: string;
}

export async function createCloudflareApplication(bindings: CloudflareChatEnv) {
  if (!bindings.MODEL_CREDENTIALS) {
    throw new Error(
      "MODEL_CREDENTIALS is required; use pnpm dev:yo-chat --mode cloudflare for local auth",
    );
  }
  const records = JSON.parse(bindings.MODEL_CREDENTIALS) as Record<string, Credential>;
  const credentials = new InMemoryCredentialStore();
  for (const [id, credential] of Object.entries(records)) {
    await credentials.modify(id, async () => credential);
  }
  const models = createYoChatModels(credentials);
  return createCloudflareChatApplication(
    bindings,
    pi({
      provider: bindings.DEFAULT_CHAT_MODEL_PROVIDER,
      model: bindings.DEFAULT_CHAT_MODEL_ID,
      models,
    }),
  );
}

export const chatApp = {
  handler: createChatFetchHandler(() =>
    createCloudflareApplication(env as unknown as CloudflareChatEnv),
  ),
  async inspect() {
    const app = await createCloudflareApplication(env as unknown as CloudflareChatEnv);
    try {
      return await app.inspect();
    } finally {
      await app.close();
    }
  },
};
