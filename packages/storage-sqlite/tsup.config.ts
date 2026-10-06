import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    schema: "src/schema.ts",
    client: "src/client.ts",
    repository: "src/repository.ts",
    "sqlite-kernel": "src/sqlite-kernel.ts",
    "better-sqlite3": "src/better-sqlite3.ts",
    initialize: "src/initialize.ts",
    inspection: "src/inspection.ts",
    segmentation: "src/segmentation.ts",
    "checkpoint-bounds": "src/checkpoint-bounds.ts",
    testing: "src/testing.ts",
    metrics: "src/metrics.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
