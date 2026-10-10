import { expect, it } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createTisynModels } from "../cloudflare/model-catalog.ts";

it("resolves OpenCode Haiku 5.5 without installing a Copilot provider", () => {
  const models = createTisynModels(new InMemoryCredentialStore());
  expect(models.getModel("opencode", "claude-haiku-5-5")).toMatchObject({
    id: "claude-haiku-5-5",
    api: "anthropic-messages",
    compat: { forceAdaptiveThinking: true },
  });
  expect(models.getModel("github-copilot", "claude-sonnet-5.5")).toBeUndefined();
});
