import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@sweatpants/model-provider-pi-ai";
import { createYoChatModels } from "../model-catalog";

afterEach(() => vi.unstubAllEnvs());

it("routes OpenAI models to the configured endpoint without changing other providers", () => {
  vi.stubEnv("OPENAI_BASE_URL", "http://localhost:8317/v1");
  const models = createYoChatModels(new FileCredentialStore());

  expect(models.getModel("openai", "gpt-6.1-sol")?.baseUrl).toBe("http://localhost:8317/v1");
  expect(
    models.getAllModels("openai").every((model) => model.baseUrl === "http://localhost:8317/v1"),
  ).toBe(true);
  expect(models.getModel("opencode", "claude-haiku-5-5")?.baseUrl).toBe("https://opencode.ai/zen");
});

it("uses the built-in OpenAI endpoint when no override is configured", () => {
  vi.stubEnv("OPENAI_BASE_URL", undefined);
  const models = createYoChatModels(new FileCredentialStore());

  expect(models.getModel("openai", "gpt-6.1-sol")?.baseUrl).toBe("https://api.openai.com/v1");
});
