import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", content: "src/content.ts" },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
  treeshake: true,
  skipNodeModulesBundle: true,
});
