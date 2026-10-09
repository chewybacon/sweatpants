import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import type { CredentialStore, Model } from "@earendil-works/pi-ai";

/** App-owned catalog additions for models newer than the installed Pi catalog. */
export function createYoChatModels(credentials: CredentialStore) {
  const models = builtinModels({ credentials });
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
