import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: [
    "react",
    "effection",
    "@effectionx/raf",
    "marked",
    "shiki",
    "mermaid",
    "katex",
    "tailwind-merge",
  ],
  treeshake: true,
  skipNodeModulesBundle: true,
});
