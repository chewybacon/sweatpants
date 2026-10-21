import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: { conditions: ["development"] },
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    // Each file compiles the large Hoot module; bound contention without extending test budgets.
    maxWorkers: 1,
    minWorkers: 1,
  },
});
