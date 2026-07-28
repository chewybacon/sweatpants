import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "response-streams/index": "src/response-streams/index.ts",
    "response-streams/testing": "src/response-streams/__tests__/vitest-effection.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
