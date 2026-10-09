import { FileCredentialStore } from "@sweatpants/model-provider-pi-ai";
import { pi } from "@sweatpants/model-provider-pi-ai";
import { createYoChatModels } from "./model-catalog";
import { defaultYoChatModel } from "./default-model";
import { getThreadMetadataStore } from "@/lib/thread-metadata-store";
import { createChatApp, type ChatApp } from "@sweatpants/agent-host/server";
import { setupLogger } from "@sweatpants/agent-host/logging";
import { setupYoChatDurableStreams } from "./durable-streams";
import { setupYoChatBaseContexts } from "./tools";
import { yoChatToolConfig } from "./tool-runtime";
import { yoChatConfig } from "./chat-handler";
export { withDefaultSystemPrompt } from "./default-system-prompt";
export { ProgramDriverConfigurationError } from "./chat-handler";

export type YoChatApplication = ChatApp;

/** Creates yo-chat with one root scope and route-independent endpoints. */
export function createYoChatApplication(): YoChatApplication {
  const { setup: chat, programs: _programs, ...config } = yoChatConfig();
  const metadata = getThreadMetadataStore();
  const selection = defaultYoChatModel();
  const app = createChatApp({
    ...config,
    ...yoChatToolConfig(),
    model: pi({
      provider: selection.provider,
      model: selection.id,
      models: createYoChatModels(new FileCredentialStore()),
    }),
    setup: {
      chat,
      application: function* setupApplication() {
        yield* setupLogger();
        yield* setupYoChatDurableStreams();
        yield* setupYoChatBaseContexts();
      },
    },
  });
  return {
    ...app,
    async close() {
      try {
        await app.close();
      } finally {
        await metadata.close?.();
      }
    },
  };
}

export const chatApp = createYoChatApplication();
