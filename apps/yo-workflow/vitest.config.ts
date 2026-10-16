import { defineConfig } from "vitest/config";
import { unplugin as stylex } from "@stylexjs/unplugin";

const domTests = ["src/**/__tests__/*.test.tsx", "src/threads/__tests__/thread-index.test.ts"];

export default defineConfig({
  plugins: [stylex.rollup()],
  resolve: {
    conditions: ["development"],
  },
  // Bound concurrent workerd instances; each acceptance file starts its own host.
  test: {
    maxWorkers: 4,
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
          exclude: domTests,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: domTests,
          // Keep Node fetch and its abort primitives together while jsdom provides the DOM.
          environment: "../../scripts/testing/jsdom-with-node-fetch.ts",
        },
      },
    ],
  },
});
