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
