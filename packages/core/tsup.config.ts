import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    transport: "src/transport/index.ts",
    "transport/sse": "src/transport/sse/index.ts",
    "transport/websocket": "src/transport/websocket/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
});
