import type { Model } from "@earendil-works/pi-ai";
import type { ModelInfo, ReasoningLevel } from "@sweatpan.ts/providers";

/** Project SDK selection into immutable credential-free model information. */
export function describePiAiModel(model: Model<string>): ModelInfo {
  const levels: readonly ReasoningLevel[] = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ];
  return Object.freeze({
    id: model.id,
    provider: model.provider,
    api: model.api,
    name: model.name,
    input: Object.freeze([...model.input]),
    output: Object.freeze(["text"] as const),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    reasoningLevels: Object.freeze(
      model.reasoning ? levels.filter((level) => model.thinkingLevelMap?.[level] !== null) : [],
    ),
  });
}
