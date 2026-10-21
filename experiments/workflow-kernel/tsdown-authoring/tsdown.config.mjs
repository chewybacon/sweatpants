import { luaWorkflowCompiler } from "../../../packages/flowmode-compiler-lua/dist/index.js";
import { reviewExports, reviewImports } from "../../../apps/yo-workflow/execution/contracts.mts";
import { fileURLToPath } from "node:url";
import { workflowArtifactPlugin } from "../../../packages/vite-plugin/src/workflow-artifacts.ts";
import { schemeWorkflowCompiler } from "../../../packages/flowmode-compiler-scheme/dist/index.js";
export default {
  entry: [
    fileURLToPath(
      new URL("../../../apps/yo-workflow/execution/review-draft.workflow.ts", import.meta.url),
    ),
  ],
  outDir: fileURLToPath(new URL("./dist", import.meta.url)),
  format: "esm",
  platform: "neutral",
  deps: { neverBundle: [/^@sweatpants\//, "zod", "effection"] },
  dts: true,
  plugins: [
    workflowArtifactPlugin(
      { entry: "review_draft", exports: reviewExports, bindings: reviewImports },
      { compiler: schemeWorkflowCompiler },
    ),
    workflowArtifactPlugin(
      { entry: "review_draft", exports: reviewExports, bindings: reviewImports },
      { compiler: luaWorkflowCompiler, artifactName: "lua.artifact" },
    ),
  ],
};
