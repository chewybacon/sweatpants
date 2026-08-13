import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    store: "src/store.ts",
    "store-persistence": "src/store-persistence.ts",
    "store-planners": "src/store-planners.ts",
    "store-repository": "src/store-repository.ts",
    memory: "src/memory.ts",
    api: "src/api.ts",
    testing: "src/testing.ts",
    "turn-authority": "src/turn-authority.ts",
    "schema-registry": "src/schema-registry.ts",
    segmentation: "src/segmentation.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
