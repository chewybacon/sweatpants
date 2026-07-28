import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/model.ts", "src/chat.ts", "src/history.ts", "src/scenario.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ["effection", "zod"],
  treeshake: true,
  skipNodeModulesBundle: true,
});
