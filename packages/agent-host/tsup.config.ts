import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    "primitive/activation": "src/primitive/activation.ts",
    "primitive/app": "src/primitive/app.ts",
    index: "src/index.ts",
    "mcp/index": "src/mcp/index.ts",
    "node/index": "src/node/index.ts",
    "server/index": "src/server/index.ts",
    "deployment/index": "src/deployment/index.ts",
    "logging/index": "src/logging/index.ts",
  },
  format: ["esm"],
  // node:sqlite is a prefix-only builtin; stripping node: creates an invalid package import.
  removeNodeProtocol: false,
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
