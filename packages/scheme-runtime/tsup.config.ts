import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/evaluation.ts", "src/node.ts", "src/worker.ts"],
  format: ["esm"],
  external: ["../generated/reflect-worker.mjs"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
