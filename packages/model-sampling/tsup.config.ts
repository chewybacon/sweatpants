import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    api: "src/api.ts",
    delivery: "src/delivery.ts",
    placement: "src/placement.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
