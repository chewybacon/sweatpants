import { defineConfig } from "vitest/config";
import { unplugin as stylex } from "@stylexjs/unplugin";

export default defineConfig({
  plugins: [stylex.rollup()],
  resolve: {
    conditions: ["development"],
  },
  test: { include: ["src/**/__tests__/**/*.test.{ts,tsx}"], testTimeout: 10_000 },
});
