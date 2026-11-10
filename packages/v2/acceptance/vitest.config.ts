import { unplugin as stylex } from "@stylexjs/unplugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [stylex.vite({ useCSSLayers: true })],
  resolve: { conditions: ["development"] },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "node", include: ["__tests__/**/*.acceptance.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: ["__tests__/**/*.acceptance.test.tsx"],
          environment: "./jsdom-with-node-runtime.ts",
        },
      },
    ],
    maxWorkers: 1,
    minWorkers: 1,
    bail: 1,
    retry: 0,
    testTimeout: 30_000,
  },
});
