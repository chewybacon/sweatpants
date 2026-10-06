import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    hooks: "src/hooks.ts",
    bindings: "src/bindings.ts",
  },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["esm"],
  dts: false,
  bundle: false,
  clean: true,
  sourcemap: true,
  skipNodeModulesBundle: true,
});
