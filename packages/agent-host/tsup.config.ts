import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "mcp/index": "src/mcp/index.ts",
    "node/index": "src/node/index.ts",
    "server/index": "src/server/index.ts",
    "deployment/index": "src/deployment/index.ts",
    "logging/index": "src/logging/index.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
