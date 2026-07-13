import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", host: "src/host.ts" },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["cjs", "esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: false,
  external: [
    "@sweatpants/framework",
    "@sweatpants/session-contract",
    "effection",
    "zod",
    "@aws-sdk/client-bedrock-agentcore",
    "redis",
  ],
  treeshake: true,
  skipNodeModulesBundle: true,
});
