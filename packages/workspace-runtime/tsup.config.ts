import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", api: "src/api.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: {
    compilerOptions: { composite: false },
  },
  sourcemap: true,
  clean: true,
  external: ["effection", "@sweatpants/session-contract"],
});
