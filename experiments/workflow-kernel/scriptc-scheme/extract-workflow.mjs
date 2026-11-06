import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { compileWorkflow } from "./live.mjs";
import { input } from "./input.mjs";

// Recording is optional output of the same live compiler, not a second pipeline.
const { ir: module, admitted, compiler } = compileWorkflow(input);
const directory = new URL("./workflow/", import.meta.url);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ir = JSON.stringify(module, null, 2) + "\n";
writeFileSync(new URL("review.ir.json", directory), ir);
writeFileSync(new URL("normalized.ts", directory), admitted.source);
const provenance = {
  compiler,
  hashes: {
    source: sha(input.source.text),
    helper: sha(input.modules["helper.ts"]),
    normalized: sha(admitted.source),
    ir: sha(ir),
  },
  sites: admitted.sites,
  preflight: [],
  diagnostics: [],
};
writeFileSync(new URL("provenance.json", directory), JSON.stringify(provenance, null, 2) + "\n");
console.log(provenance);
