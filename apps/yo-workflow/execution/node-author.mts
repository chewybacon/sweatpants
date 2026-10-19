import { FileCredentialStore } from "@sweatpants/model-provider-pi-ai";
import { createWorkflowModels } from "../src/server/cloudflare/model-catalog.ts";
import { authorCaller } from "../src/execution/author.ts";

export function authorLocalCaller(
  prompt: string,
  validate: (source: string) => Promise<string>,
  authoring: { language: string; instructions: string },
) {
  return authorCaller(prompt, validate, {
    ...authoring,
    models: createWorkflowModels(new FileCredentialStore(), {
      openaiBaseUrl: process.env.OPENAI_BASE_URL,
    }),
    provider: process.env.DEFAULT_CHAT_MODEL_PROVIDER ?? "opencode",
    model: process.env.DEFAULT_CHAT_MODEL_ID ?? "claude-haiku-5-5",
    thinking: process.env.DEFAULT_CHAT_MODEL_THINKING,
  });
}
