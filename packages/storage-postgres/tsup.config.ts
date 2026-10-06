import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    schema: "src/schema.ts",
    repository: "src/repository.ts",
    "pg-kernel": "src/pg-kernel.ts",
    "pg-binding": "src/pg-binding.ts",
    initialize: "src/initialize.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
