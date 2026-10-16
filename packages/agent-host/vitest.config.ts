import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Server APIs use Node's Request and AbortSignal together; no DOM is needed.
    environment: "node",
    setupFiles: [],
    // Exclude e2e tests - they have their own config and require a running server
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
