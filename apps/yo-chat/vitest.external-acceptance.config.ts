import { defineConfig } from "vitest/config";
import viteTsConfigPaths from "vite-tsconfig-paths";

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
      DEFAULT_CHAT_MODEL_PROVIDER: "github-copilot",
      DEFAULT_CHAT_MODEL_ID: "claude-sonnet-4.5",
    },
  },
});
