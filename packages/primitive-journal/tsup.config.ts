import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite.ts", example: "src/example.ts" },
  format: ["esm"],
  // node:sqlite is a prefix-only builtin; stripping node: creates an invalid package import.
  removeNodeProtocol: false,
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
