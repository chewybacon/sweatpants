import { fileURLToPath } from "node:url";
import { workflowPlugin } from "./plugin.mjs";
export default {
    entry: [fileURLToPath(new URL("./review-draft.workflow.ts", import.meta.url))],
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    format: "esm",
    platform: "neutral",
    dts: true,
    plugins: [workflowPlugin()],
};
