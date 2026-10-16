import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "../../scripts/testing/jsdom-with-node-fetch.ts",
  },
});
