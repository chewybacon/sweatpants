import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    http: "src/http.ts",
    ports: "src/ports.ts",
  },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ["effection", "@sweatpants/frame-renderer"],
  treeshake: true,
  skipNodeModulesBundle: true,
});
