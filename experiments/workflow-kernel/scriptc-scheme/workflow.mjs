import { bindEffectBoundary } from "./boundary.mts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { admitWorkflow as admit } from "./admit.mjs";
import { effects } from "./contract.mts";
const admitWorkflow = (text, helper, definitions = effects) => admit(text, helper, definitions);
import { admitInput, projectWorkflow } from "./assembly.mjs";
const read = (name) => readFileSync(new URL(`./workflow/${name}`, import.meta.url), "utf8");
import { input, authored, helper, outcomeInput } from "./input.mjs";
export { input, authored, helper, outcomeInput };
function lowerRecorded(input, outcome = false) {
  const irText = read(outcome ? "review-outcome.ir.json" : "review.ir.json");
  const provenance = JSON.parse(read(outcome ? "outcome-provenance.json" : "provenance.json"));
  const { helperText, admitted } = admitInput(input);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  for (const [name, value] of Object.entries({
    source: input.source.text,
    helper: helperText,
    normalized: admitted.source,
    ir: irText,
  })) {
    if (sha(value) !== provenance.hashes[name]) {
      throw new Error(`Stale ScriptC workflow fixture: ${name}; rerun extract-workflow.mjs`);
    }
  }
  const ir = JSON.parse(irText);
  return projectWorkflow(ir, admitted, helperText);
}
// Recorded-frontend adapter for the acceptance assembly. Live extraction remains
// in extract-workflow.mjs; changed source fails rather than reusing stale IR.
export const frontend = {
  *lower(input) {
    return lowerRecorded(input).module;
  },
};
export const debug = lowerRecorded(input).debug;
export { admitWorkflow };

// Reference assembly grants are explicit and separate from the compiler catalog.
export const decodeRequest = bindEffectBoundary(lowerRecorded(input).module, [
  "scriptc.review.approval",
  "scriptc.review.cleanup",
]);
export { bindEffectBoundary };
export { authoringGuide } from "./macros.mts";

export const outcomeFrontend = {
  *lower(input) {
    return lowerRecorded(input, true).module;
  },
};
