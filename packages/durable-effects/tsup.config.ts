import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    authoring: "src/authoring.ts",
    runtime: "src/runtime.ts",
    "model-sample-contract": "src/model-sample-contract.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
