import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", sqlite: "src/sqlite.ts", example: "src/example.ts" },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
