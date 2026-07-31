import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contract: "src/contract.ts",
    "event-log": "src/event-log.ts",
    foreign: "src/foreign.ts",
    "mcp/index": "src/mcp/index.ts",
    "tool-parameters": "src/tool-parameters.ts",
    messages: "src/messages.ts",
    "elicit-context/index": "src/elicit-context/index.ts",
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
