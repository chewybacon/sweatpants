import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    store: "src/store/store.ts",
    "store-persistence": "src/store/store-persistence.ts",
    "store-planners": "src/store/store-planners.ts",
    "store-repository": "src/store/store-repository.ts",
    memory: "src/store/memory.ts",
    api: "src/api.ts",
    testing: "src/testing/testing.ts",
    "turn-authority": "src/shell/turn-authority.ts",
    "schema-registry": "src/contract/schema-registry.ts",
    segmentation: "src/store/segmentation.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
