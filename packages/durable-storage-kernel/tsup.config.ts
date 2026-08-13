import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    memory: "src/memory.ts",
    middleware: "src/middleware.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
