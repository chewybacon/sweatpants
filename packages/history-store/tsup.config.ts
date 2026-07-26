import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", memory: "src/memory.ts" },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
