import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelPolicyError,
  ModelResolutionError,
  ModelSelectionError,
  parseAllowedModelsJson,
  parseRequestModelSelection,
  resolveModelSelection,
  createPiAiModelProvider,
} from "../index.ts";

const piProvider = createPiAiModelProvider();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("structured model selection", () => {
  it("accepts valid request model selections and rejects malformed/extra fields", () => {
    expect(parseRequestModelSelection({ provider: "amazon-bedrock", id: "zai.glm-5" })).toEqual({
      provider: "amazon-bedrock",
      id: "zai.glm-5",
    });
    expect(() => parseRequestModelSelection({ provider: "", id: "x" })).toThrow(
      ModelSelectionError,
    );
    expect(() => parseRequestModelSelection({ provider: "amazon-bedrock", id: "" })).toThrow(
      ModelSelectionError,
    );
    expect(() =>
      parseRequestModelSelection({
        provider: "amazon-bedrock",
        id: "zai.glm-5",
        region: "eu-west-1",
      }),
    ).toThrow(ModelSelectionError);
    expect(() => parseRequestModelSelection("qwen3:30b")).toThrow(ModelSelectionError);
  });

  it("resolves request model before default and enforces safe default allow-list", () => {
    const defaultModel = { provider: "amazon-bedrock", id: "zai.glm-5" };
    expect(
      resolveModelSelection({
        requestModel: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        defaultModel,
        allowedModels: [{ provider: "github-copilot", id: "claude-sonnet-4.5" }],
      }),
    ).toEqual({ provider: "github-copilot", id: "claude-sonnet-4.5" });

    expect(resolveModelSelection({ defaultModel })).toEqual(defaultModel);
    expect(() =>
      resolveModelSelection({
        requestModel: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        defaultModel,
      }),
    ).toThrow(ModelPolicyError);
  });

  it("parses allowed model JSON and rejects invalid entries", () => {
    expect(parseAllowedModelsJson('[{"provider":"amazon-bedrock","id":"zai.glm-5"}]')).toEqual([
      { provider: "amazon-bedrock", id: "zai.glm-5" },
    ]);
    expect(() => parseAllowedModelsJson('{"provider":"amazon-bedrock"}')).toThrow(
      ModelSelectionError,
    );
    expect(() => parseAllowedModelsJson('[{"provider":"amazon-bedrock"}]')).toThrow(
      ModelSelectionError,
    );
  });

  it("unsafe mode skips only policy validation", () => {
    expect(
      resolveModelSelection({
        requestModel: { provider: "github-copilot", id: "claude-sonnet-4.5" },
        defaultModel: { provider: "amazon-bedrock", id: "zai.glm-5" },
        unsafeAllowAny: true,
      }),
    ).toEqual({ provider: "github-copilot", id: "claude-sonnet-4.5" });

    expect(() => piProvider.resolveModel({ provider: "unknown-provider", id: "nope" })).toThrow(
      ModelResolutionError,
    );
  });
});

describe("pi-ai model resolution", () => {
  it("resolves Bedrock GLM 5 through the pi-ai registry", () => {
    const model = piProvider.resolveModel({ provider: "amazon-bedrock", id: "zai.glm-5" });
    expect(model.provider).toBe("amazon-bedrock");
    expect(model.id).toBe("zai.glm-5");
    expect(model.api).toBe("bedrock-converse-stream");
    expect(model.contextWindow).toBeGreaterThan(0);
  });

  it("preserves thinkingLevelMap from pi-ai registry models", () => {
    const model = piProvider.resolveModel({
      provider: "amazon-bedrock",
      id: "anthropic.claude-opus-4-6-v1",
    });
    expect(model.thinkingLevelMap).toEqual({ xhigh: "max" });
  });

  it("rejects implicit Ollama models even with a configured endpoint", () => {
    vi.stubEnv("OLLAMA_BASE_URL", "http://localhost:11434");
    expect(() => piProvider.resolveModel({ provider: "ollama", id: "qwen3:30b" })).toThrow(
      ModelResolutionError,
    );
  });

  it("rejects unknown OpenAI models even with a configured endpoint", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://example.test/v1");
    expect(() =>
      piProvider.resolveModel({ provider: "openai", id: "custom-openai-test-model" }),
    ).toThrow(ModelResolutionError);
  });

  it("resolves known OpenAI models with catalog capabilities", () => {
    const model = piProvider.resolveModel({ provider: "openai", id: "gpt-4o" });
    expect(model).toMatchObject({
      provider: "openai",
      id: "gpt-4o",
      metadata: { source: "pi-ai-registry" },
    });
    expect(model.contextWindow).toBeGreaterThan(0);
  });
});
