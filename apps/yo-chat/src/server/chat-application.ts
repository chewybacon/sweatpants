import { createLocalYoChatApplication } from "./local-chat-application";
import { createYoChatStorageConfig } from "./storage-config";
import { env } from "@/env";
import {
  createPiAiModelProvider,
  resolveModelSelection,
  parseAllowedModelsJson,
  parseRequestModelSelection,
} from "@sweatpants/model-provider-pi-ai";
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

export type YoChatApplication = Pick<ChatApp, "handler" | "close" | "inspect">;

/** Creates yo-chat with one root scope and route-independent endpoints. */
export function createYoChatApplication(): YoChatApplication {
  const storage = createYoChatStorageConfig();
  if (env.MCP_TOOL_RUNTIME === "local" && storage.kind === "sqlite" && "path" in storage) {
    const provider = createPiAiModelProvider({
      models: createYoChatModels(new FileCredentialStore()),
    });
    const select = (value: unknown) =>
      JSON.stringify(
        resolveModelSelection({
          requestModel: parseRequestModelSelection(value, "model"),
          defaultModel: defaultYoChatModel(),
          allowedModels: parseAllowedModelsJson(env.ALLOWED_CHAT_MODELS_JSON),
          unsafeAllowAny: env.UNSAFE_ALLOW_ANY_CHAT_MODEL === "yes",
        }),
      );
    const identity = select(undefined);
    return createLocalYoChatApplication({
      database: `${storage.path}.primitive-v2`,
      model: {
        identity,
        model: provider.resolveModel(JSON.parse(identity)),
        driver: provider.driver,
        select,
        resolve: (key) => provider.resolveModel(JSON.parse(key)),
      },
    });
  }
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
