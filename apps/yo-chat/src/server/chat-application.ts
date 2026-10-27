import { local } from "@sweatpants/tool-runtime-local";
import journalToolWorkerUrl from "./journal-tool-worker.ts?modulePath";
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
import { createYoChatModels } from "./model-catalog";
import { defaultYoChatModel } from "./default-model";
import type { ChatApp } from "@sweatpants/agent-host/server";
export { withDefaultSystemPrompt } from "./default-system-prompt";

export type YoChatApplication = Pick<ChatApp, "handler" | "close" | "inspect">;

/** Local worker placement over the single public-builder tool inventory. */
export function createYoChatApplication(): YoChatApplication {
  const storage = createYoChatStorageConfig();
  if (storage.kind !== "sqlite" || !("path" in storage)) {
    throw new Error(
      "yo-chat requires local SQLite storage; remote deployment wiring has been retired",
    );
  }
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
    execution: local({ worker: new URL(journalToolWorkerUrl, import.meta.url) }),
    model: {
      identity,
      model: provider.resolveModel(JSON.parse(identity)),
      driver: provider.driver,
      select,
      resolve: (key) => provider.resolveModel(JSON.parse(key)),
    },
  });
}

export const chatApp = createYoChatApplication();
