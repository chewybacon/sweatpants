import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    memory: "src/memory.ts",
    port: "src/port.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
