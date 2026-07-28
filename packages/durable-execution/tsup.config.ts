import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    transitions: "src/transitions.ts",
    checkpoint: "src/checkpoint.ts",
    "program-contract": "src/program-contract.ts",
    "program-authoring": "src/program-authoring.ts",
    "program-authoring-runtime": "src/program-authoring-runtime.ts",
    "program-identity": "src/program-identity.ts",
    "program-driver": "src/program-driver.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
