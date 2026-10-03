import { getThreadMetadataStore } from "@/lib/thread-metadata-store";
import { createChatApp, type ChatApp } from "@sweatpants/agent-host/server";
import { setupLogger } from "@sweatpants/agent-host/logging";
import { setupYoChatDurableStreams } from "./durable-streams";
import { setupYoChatBaseContexts } from "./tools";
import { setupYoChatPluginsAndRuntime } from "./tool-runtime";
import { yoChatConfig } from "./chat-handler";
export { withDefaultSystemPrompt } from "./default-system-prompt";
export { ProgramDriverConfigurationError } from "./chat-handler";

export type YoChatApplication = ChatApp;

/** Creates yo-chat with one root scope and route-independent endpoints. */
export function createYoChatApplication(): YoChatApplication {
  const { setup: chat, ...config } = yoChatConfig();
  const metadata = getThreadMetadataStore();
  const app = createChatApp({
    ...config,
    setup: {
      ...(chat ? { chat } : {}),
      application: function* setupApplication() {
        yield* setupLogger();
        yield* setupYoChatDurableStreams();
        yield* setupYoChatBaseContexts();
        yield* setupYoChatPluginsAndRuntime();
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
