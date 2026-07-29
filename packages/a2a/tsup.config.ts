import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", testing: "src/testing.ts" },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ["@sweatpants/journal-authority", "effection", "ws"],
  treeshake: true,
  skipNodeModulesBundle: true,
});
