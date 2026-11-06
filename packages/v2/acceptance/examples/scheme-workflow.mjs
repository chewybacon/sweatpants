import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  analyzeWorkflowTools,
  prepareWorkflow,
  emitPreparedWorkflow,
} from "../../../flowmode-compiler/src/index.ts";
import { schemeWorkflowTarget } from "../../../flowmode-compiler-scheme/src/index.ts";
import {
  loadSchemeMachine as machineLoader,
  schemeRuntimeIdentity as identity,
} from "@sweatpan.ts/codemode-runtime-scheme/node";
const id = resolve(
  import.meta.dirname,
  "../../../../apps/yo-workflow/execution/review-draft.workflow.ts",
);
const text = await readFile(id, "utf8");
const declaration = analyzeWorkflowTools(text, id)[0];
const prepared = prepareWorkflow({ ...declaration, source: { id, text, language: "typescript" } });
if (prepared.diagnostics.length) {
  throw new Error(JSON.stringify(prepared.diagnostics));
}
const artifact = emitPreparedWorkflow(prepared, schemeWorkflowTarget);
const source = `${artifact.implementation.payload}
(review_draft #f %input)`;
const program = createHash("sha256")
  .update(identity + source)
  .digest("hex");
export { identity, machineLoader, program, source };
