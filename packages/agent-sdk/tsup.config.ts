import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    legacy: "src/legacy.ts",
    index: "src/index.ts",
    "tool/index": "src/tool/index.ts",
    "transport/worker": "src/transport/worker/index.ts",
  },
  tsconfig: "./tsconfig.tsup.json",
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
