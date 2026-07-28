import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    json: "src/json.ts",
    port: "src/port.ts",
    errors: "src/errors.ts",
    "schema-descriptor": "src/schema-descriptor.ts",
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
