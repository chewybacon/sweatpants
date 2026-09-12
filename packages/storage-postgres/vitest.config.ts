import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./vitest.global-setup.ts",
    // Every file shares one physical test database; migrations and seed
    // state must not race across files.
    fileParallelism: false,
  },
});
