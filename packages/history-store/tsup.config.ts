import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    memory: "src/memory.ts",
    persistence: "src/persistence.ts",
    planners: "src/planners.ts",
    port: "src/port.ts",
    repository: "src/repository.ts",
    segmentation: "src/segmentation.ts",
    "checkpoint-payload": "src/checkpoint-payload.ts",
    "checkpoint-bounds": "src/checkpoint-bounds.ts",
    conformance: "src/conformance.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
