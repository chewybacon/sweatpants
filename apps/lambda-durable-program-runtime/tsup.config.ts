import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["cjs"],
  platform: "node",
  target: "node24",
  bundle: true,
  noExternal: [/.*/],
  sourcemap: true,
  clean: true,
  dts: false,
  outExtension: () => ({ js: ".cjs" }),
});
