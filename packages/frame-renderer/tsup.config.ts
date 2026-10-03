import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts" },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ["effection", "marked", "shiki", "mermaid", "katex"],
  treeshake: true,
  skipNodeModulesBundle: true,
});
