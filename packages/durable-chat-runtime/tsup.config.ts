import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "response-streams/index": "src/response-streams/index.ts",
    "response-streams/testing": "src/response-streams/__tests__/vitest-effection.ts",
    "handler/streaming": "src/handler/streaming.ts",
    "handler/model-binder": "src/handler/model-binder.ts",
    "handler/types": "src/handler/types.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
