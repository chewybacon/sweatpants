import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["__tests__/**/*.acceptance.test.{ts,tsx}"],
    environment: "../scripts/testing/jsdom-with-node-fetch.ts",
    // Authoring and focused placement suites share a bounded resource budget.
    maxWorkers: 1,
    minWorkers: 1,
    // Stop on the first failure; retries can hide intermittent hangs.
    bail: 1,
    retry: 0,
    testTimeout: 30_000,
  },
});
