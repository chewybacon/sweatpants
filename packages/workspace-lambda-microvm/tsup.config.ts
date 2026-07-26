import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["effection", "@sweatpants/session-contract", "@sweatpants/workspace-runtime"],
});
