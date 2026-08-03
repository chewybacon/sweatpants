import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    json: "src/json.ts",
    port: "src/port.ts",
    stream: "src/stream.ts",
    errors: "src/errors.ts",
    schema: "src/schema.ts",
    "schema-validation": "src/schema-validation.ts",
  },
  format: ["esm"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  sourcemap: true,
});
