import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    store: "src/store.ts",
    memory: "src/memory.ts",
    api: "src/api.ts",
    testing: "src/testing.ts",
    "schema-registry": "src/schema-registry.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
