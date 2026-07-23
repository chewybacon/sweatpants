import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/cli.ts",
    "src/config.ts",
    "src/remote-development.ts",
    "src/remote-development-evaluator.ts",
  ],
  format: ["esm"],
  tsconfig: "../ts-config/tsconfig.tsup.json",
  dts: false,
  sourcemap: true,
  clean: true,
  target: "node20",
  banner: {
    js: "#!/usr/bin/env node",
  },
});
