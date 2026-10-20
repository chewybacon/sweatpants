import { luaWorkflowCompiler } from "../lua-compiler/compiler.mjs";
import { reviewExports, reviewImports } from "./contracts.mts";
import { fileURLToPath } from "node:url";
import { workflowPlugin } from "./plugin.mjs";
export default {
  entry: [fileURLToPath(new URL("./review-draft.workflow.ts", import.meta.url))],
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  format: "esm",
  platform: "neutral",
  deps: { neverBundle: [/^@sweatpants\//, "zod", "effection"] },
  dts: true,
  plugins: [
    workflowPlugin({ entry: "review_draft", exports: reviewExports, bindings: reviewImports }),
    workflowPlugin(
      { entry: "review_draft", exports: reviewExports, bindings: reviewImports },
      { compiler: luaWorkflowCompiler, artifactName: "lua.artifact" },
    ),
  ],
};
