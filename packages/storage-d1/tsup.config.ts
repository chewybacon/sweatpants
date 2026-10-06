import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts" },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ["effection"],
  skipNodeModulesBundle: true,
});
