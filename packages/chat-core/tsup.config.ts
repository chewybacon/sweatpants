import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    content: "src/content.ts",
    "ag-ui": "src/ag-ui/index.ts",
    client: "src/client.ts",
  },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ["effection"],
  treeshake: true,
  skipNodeModulesBundle: true,
});
