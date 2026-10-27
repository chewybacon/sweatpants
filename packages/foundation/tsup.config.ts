import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    computation: "src/computation.ts",
    execution: "src/execution.ts",
    journal: "src/journal.ts",
    json: "src/json.ts",
    port: "src/port.ts",
    stream: "src/stream.ts",
    projection: "src/projection.ts",
    errors: "src/errors.ts",
    schema: "src/schema.ts",
    "schema-validation": "src/schema-validation.ts",
    parser: "src/parser.ts",
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
