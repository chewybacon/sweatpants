import { FileCredentialStore } from "@sweatpants/model-provider-pi-ai";
import type { Operation } from "effection";
import type { ChatHandlerSetupContext } from "@sweatpants/durable-chat-runtime/durable-handler";
import {
  createPiAiModelProvider,
  parseAllowedModelsJson,
  parseRequestModelSelection,
  resolveModelSelection,
  type ModelSelection,
} from "@sweatpants/model-provider-pi-ai";
import { defaultYoChatModel } from "./default-model.ts";
import { env } from "@/env";
import { createYoChatModels } from "./model-catalog";
const piProvider = createPiAiModelProvider({
  models: createYoChatModels(new FileCredentialStore()),
});

type ChatRequestModelBody = {
  model?: unknown;
};

function defaultChatModel(): ModelSelection {
  return defaultYoChatModel();
}

export function* setupYoChatModelProvider(ctx: ChatHandlerSetupContext): Operation<void> {
  const body = ctx.body as ChatRequestModelBody;
  const requestModel = parseRequestModelSelection(body.model, "model");
  const selection = resolveModelSelection({
    requestModel,
    defaultModel: defaultChatModel(),
    allowedModels: parseAllowedModelsJson(env.ALLOWED_CHAT_MODELS_JSON),
    unsafeAllowAny: env.UNSAFE_ALLOW_ANY_CHAT_MODEL === "yes",
  });

  yield* piProvider.install({ model: piProvider.resolveModel(selection) });
}
