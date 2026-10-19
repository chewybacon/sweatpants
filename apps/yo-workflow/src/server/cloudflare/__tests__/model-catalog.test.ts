import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createWorkflowModels } from "../model-catalog.ts";

it("resolves OpenCode Haiku and Copilot alternatives", () => {
  const models = createWorkflowModels(new InMemoryCredentialStore());
  expect(models.getModel("opencode", "claude-haiku-5-5")).toMatchObject({
    id: "claude-haiku-5-5",
    api: "anthropic-messages",
    compat: { forceAdaptiveThinking: true },
  });
  expect(models.getModel("github-copilot", "gpt-6.1-sol")).toMatchObject({
    api: "openai-responses",
    reasoning: true,
  });
  expect(models.getModel("github-copilot", "claude-opus-5.5")).toMatchObject({
    api: "anthropic-messages",
    compat: { forceAdaptiveThinking: true },
  });
});

it("routes OpenAI models through an explicitly configured proxy", () => {
  const models = createWorkflowModels(new InMemoryCredentialStore(), {
    openaiBaseUrl: "http://localhost:8317/v1",
  });
  expect(models.getModel("openai", "gpt-6.1-sol")).toMatchObject({
    api: "openai-responses",
    baseUrl: "http://localhost:8317/v1",
  });
  expect(
    models.getAllModels("openai").every((model) => model.baseUrl === "http://localhost:8317/v1"),
  ).toBe(true);
  expect(models.getModel("opencode", "claude-haiku-5-5")?.baseUrl).toBe("https://opencode.ai/zen");
});

it("keeps OpenAI's default endpoint without proxy configuration", () => {
  const models = createWorkflowModels(new InMemoryCredentialStore());
  expect(models.getModel("openai", "gpt-6.1-sol")?.baseUrl).toBe("https://api.openai.com/v1");
});
