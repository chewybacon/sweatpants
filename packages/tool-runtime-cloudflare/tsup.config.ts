import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", executor: "src/executor.ts", sessions: "src/sessions.ts" },
  tsconfig: "../ts-config/tsconfig.tsup.json",
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
  external: ["cloudflare:workers", "effection"],
  skipNodeModulesBundle: true,
});
