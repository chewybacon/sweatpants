import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "node-storage": "src/durable-handler/storage-node.ts",
    streaming: "src/streaming.ts",
    "response-streams/index": "src/response-streams/index.ts",
    "response-streams/testing": "src/response-streams/__tests__/vitest-effection.ts",
    "interrupts/index": "src/interrupts/index.ts",
    "program-driver/effects": "src/program-driver/effects.ts",
    "program-driver/native-tools": "src/program-driver/native-tools.ts",
    projection: "src/projection.ts",
    "durable-handler/index": "src/durable-handler/index.ts",
    contexts: "src/contexts.ts",
    "tool-inventory": "src/tool-inventory.ts",
    "host/host-scope": "src/host/host-scope.ts",
    "logger/index": "src/logger/index.ts",
  },
  format: ["esm"],
  dts: { compilerOptions: { composite: false } },
  clean: true,
  sourcemap: true,
});
