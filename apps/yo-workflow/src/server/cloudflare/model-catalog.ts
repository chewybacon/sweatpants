import { createModels, type CredentialStore, type Model } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";

/** App-owned catalog additions for models newer than the installed Pi catalog. */
export function createWorkflowModels(
  credentials: CredentialStore,
  options: { openaiBaseUrl?: string } = {},
) {
  const models = createModels({ credentials });
  models.setProvider(githubCopilotProvider());
  const openai = openaiProvider();
  const baseUrl = options.openaiBaseUrl;
  models.setProvider(
    baseUrl === undefined
      ? openai
      : {
          ...openai,
          baseUrl,
          getModels: () => openai.getModels().map((model) => ({ ...model, baseUrl })),
          getAllModels: () =>
            (openai.getAllModels?.() ?? openai.getModels()).map((model) => ({ ...model, baseUrl })),
        },
  );
  const provider = opencodeProvider();
  // OpenCode's /zen/v1/models and models.dev catalog, verified 2026-10-08.
  const haiku: Model<"anthropic-messages"> = {
    type: "chat",
    id: "claude-haiku-5-5",
    name: "Claude Haiku 5.5",
    api: "anthropic-messages",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [
        { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
      ],
    },
    compat: { forceAdaptiveThinking: true, supportsTemperature: false },
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  };
  models.setProvider({
    ...provider,
    getModels: () => [...provider.getModels().filter((model) => model.id !== haiku.id), haiku],
    getAllModels: () => [
      ...(provider.getAllModels?.() ?? provider.getModels()).filter(
        (model) => model.id !== haiku.id,
      ),
      haiku,
    ],
  });
  return models;
}
