import { defineConfig } from "vitest/config";
import { unplugin as stylex } from "@stylexjs/unplugin";

export default defineConfig({
  plugins: [stylex.rollup()],
  resolve: {
    conditions: ["development"],
  },
  // Bound concurrent workerd instances; each acceptance file starts its own host.
  test: { maxWorkers: 4, include: ["src/**/__tests__/**/*.test.{ts,tsx}"], testTimeout: 10_000 },
});
