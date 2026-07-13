import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", worker: "src/worker.ts" },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ["@sweatpants/framework", "@sweatpants/session-contract", "effection", "zod"],
  treeshake: true,
  skipNodeModulesBundle: true,
});
