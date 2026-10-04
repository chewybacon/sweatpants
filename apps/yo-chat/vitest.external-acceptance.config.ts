import { defineConfig } from "vitest/config";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { readStoredModelSelection } from "@sweatpants/model-provider-pi-ai";

const selectedModel = readStoredModelSelection();

/**
 * Opt-in tests that require a real Redis or AgentCore substrate. Kept separate
 * so the default hermetic suite does not collect their external dependency
 * graph merely to skip them.
 */
export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    environment: "node",
    include: ["acceptance/**/*.external.acceptance.test.ts"],
    env: {
      DEFAULT_CHAT_MODEL_PROVIDER:
        process.env["DEFAULT_CHAT_MODEL_PROVIDER"] ?? selectedModel?.provider ?? "github-copilot",
      DEFAULT_CHAT_MODEL_ID:
        process.env["DEFAULT_CHAT_MODEL_ID"] ?? selectedModel?.id ?? "claude-sonnet-4.6",
    },
  },
});
