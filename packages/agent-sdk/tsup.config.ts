import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "tool/index": "src/tool/index.ts",
    "transport/worker": "src/transport/worker/index.ts",
  },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
