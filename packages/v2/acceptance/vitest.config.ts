import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["__tests__/**/*.acceptance.test.ts"],
    environment: "node",
    maxWorkers: 1,
    minWorkers: 1,
    bail: 1,
    retry: 0,
    testTimeout: 30_000,
  },
});
