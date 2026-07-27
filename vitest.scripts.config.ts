import { defineConfig } from "vitest/config";

/**
 * Repository-tooling tests. These live outside the package graph because they
 * exercise `scripts/`, which no package depends on, so they are not picked up by
 * the recursive per-package test run.
 */
export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
